import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "dotenv";

const MAX_FILE_BYTES = 65_536;
class GoogleSetupError extends Error {}

function localOrigin(environment: Record<string, string>) {
  let url: URL;
  try { url = new URL(environment.AUTH_URL); }
  catch { throw new GoogleSetupError("Configure AUTH_URL antes de importar as credenciais."); }
  if (environment.APP_ENV !== "development" || url.protocol !== "http:"
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new GoogleSetupError("A importação exige o ambiente de desenvolvimento HTTP local.");
  }
  return url.origin;
}

/** Returns the updated text without modifying existing lines or exposing secrets. */
export function prepareGoogleEnvironment(contents: string, credentialsJson: string): string {
  const environment = parse(contents);
  const origin = localOrigin(environment);
  let document: unknown;
  try { document = JSON.parse(credentialsJson.replace(/^\uFEFF/, "")); }
  catch { throw new GoogleSetupError("O arquivo não contém um JSON de credenciais válido."); }
  const web = document && typeof document === "object" && !Array.isArray(document)
    ? (document as Record<string, unknown>).web : null;
  if (!web || typeof web !== "object" || Array.isArray(web)) {
    throw new GoogleSetupError("Baixe as credenciais de um cliente Google do tipo Aplicativo da Web.");
  }
  const record = web as Record<string, unknown>;
  const clientId = record.client_id;
  const clientSecret = record.client_secret;
  // These safe characters cannot inject another dotenv assignment or expansion.
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/.test(clientId)
    || typeof clientSecret !== "string" || !/^[A-Za-z0-9_-]{16,512}$/.test(clientSecret)) {
    throw new GoogleSetupError("O JSON não contém um ID e um segredo de cliente válidos.");
  }
  if (!Array.isArray(record.redirect_uris) || !record.redirect_uris.includes(`${origin}/api/auth/callback/google`)) {
    throw new GoogleSetupError("Cadastre o callback exato do Prevision no cliente Google e baixe o JSON atualizado.");
  }
  const credentials = { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret };
  const additions: string[] = [];
  for (const [key, value] of Object.entries(credentials)) {
    if (environment[key] && environment[key] !== value) {
      throw new GoogleSetupError("Já existem credenciais Google diferentes no .env; nenhuma configuração foi alterada.");
    }
    if (!environment[key]) additions.push(`${key}=${value}`);
  }
  if (!additions.length) return contents;
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const separator = contents.endsWith("\n") || contents.length === 0 ? "" : newline;
  return contents + separator + "# Login Google local; não versionar credenciais." + newline + additions.join(newline) + newline;
}

async function readLimitedFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
    throw new GoogleSetupError("Selecione um arquivo JSON de credenciais com até 64 KiB.");
  }
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw new GoogleSetupError("O arquivo ultrapassa o limite de 64 KiB.");
    return buffer.subarray(0, size).toString("utf8");
  } finally { await file.close(); }
}

async function main() {
  if (process.argv.length !== 3) throw new GoogleSetupError("Use: npm.cmd run auth:google -- caminho-do-arquivo.json");
  const workspace = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const environmentPath = join(workspace, ".env");
  const original = await readLimitedFile(environmentPath);
  const next = prepareGoogleEnvironment(original, await readLimitedFile(resolve(process.argv[2])));
  if (original === next) {
    console.info("As mesmas credenciais Google já estão configuradas. O .env foi preservado.");
    return;
  }
  const temporary = join(workspace, `.env.google-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    created = true;
    try { await file.writeFile(next, "utf8"); await file.sync(); }
    finally { await file.close(); }
    if (await readFile(environmentPath, "utf8") !== original) {
      throw new GoogleSetupError("O .env mudou durante a importação. Tente novamente; nenhuma configuração foi substituída.");
    }
    await rename(temporary, environmentPath);
    created = false;
    console.info("Credenciais Google importadas no .env. Reinicie a aplicação. Nenhum segredo foi exibido.");
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof GoogleSetupError ? error.message : "Não foi possível importar as credenciais. Confira o arquivo e o .env; detalhes privados foram omitidos.");
    process.exitCode = 1;
  });
}
