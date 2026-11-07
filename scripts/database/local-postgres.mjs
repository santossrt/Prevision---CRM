import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, unlinkSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "dotenv";
import pg from "pg";

const executeFile = promisify(execFile);
const SOURCE_URL = "https://get.enterprisedb.com/postgresql/postgresql-17.11-4-windows-x64-binaries.zip";
const SOURCE_SHA256 = "b9424ee7bc60b52450ff910a3630225df32e633f3cb29c1d126d9299d59aea28";
const PORT = "54329";
const HOST = "127.0.0.1";
const DATABASE = "prevision_dev";
const ADMIN = "prevision_admin";
const APP_USER = "prevision_app";
const DATABASE_ID = "prevision-local-development";
const workspace = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const cache = join(workspace, ".cache", "postgres");
const archive = join(cache, "archive.zip");
const partialArchive = join(cache, "archive.zip.part");
const binaries = join(cache, "binaries");
const bin = join(binaries, "pgsql", "bin");
const data = join(cache, "data");
const logs = join(cache, "logs");
const launcherLog = join(logs, "launcher.log");
const serverLog = join(logs, "postgresql.log");
const markerFile = join(cache, "cluster.json");
let passwordFile;

class LocalPostgresError extends Error {}

function fail(message) {
  throw new LocalPostgresError(message);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function insideWorkspace(path) {
  const suffix = relative(workspace, path);
  return suffix !== ".." && !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(suffix);
}

// Check existing ancestors as well, so a junction cannot redirect writes out
// of this workspace. No cluster directory is deleted or moved by this script.
async function assertWorkspacePath(path) {
  if (!insideWorkspace(resolve(path))) fail("O cache deve permanecer dentro da pasta do projeto.");
  let existing = path;
  while (!(await exists(existing))) existing = dirname(existing);
  if (!insideWorkspace(await realpath(existing))) fail("O cache aponta para fora da pasta do projeto.");
}

function readLocalEnvironment() {
  config({ path: join(workspace, ".env"), quiet: true });
  if (process.platform !== "win32" || process.arch !== "x64") fail("Esta alternativa requer Windows x64.");
  if (
    process.env.APP_ENV !== "development"
    || process.env.DATABASE_ID !== DATABASE_ID
    || process.env.POSTGRES_DB !== DATABASE
    || process.env.POSTGRES_USER !== ADMIN
  ) fail("A alternativa portátil exige o ambiente local de desenvolvimento do Prevision.");

  const adminPassword = process.env.POSTGRES_PASSWORD;
  const appPassword = process.env.POSTGRES_APP_PASSWORD;
  if (![adminPassword, appPassword].every((value) => value && !/[\r\n\0]/.test(value))) {
    fail("Configure as duas senhas locais no .env antes de continuar.");
  }

  for (const [key, user, password] of [
    ["DIRECT_URL", ADMIN, adminPassword],
    ["DATABASE_URL", APP_USER, appPassword]
  ]) {
    let url;
    try {
      url = new URL(process.env[key]);
      if (
        !["postgres:", "postgresql:"].includes(url.protocol)
        || url.hostname !== HOST
        || url.port !== PORT
        || url.pathname !== `/${DATABASE}`
        || decodeURIComponent(url.username) !== user
        || decodeURIComponent(url.password) !== password
        || url.hash
      ) throw new Error();
    } catch {
      fail(`${key} deve apontar para o banco e usuário locais esperados, com a senha correspondente do .env.`);
    }
  }
  return { adminPassword, appPassword };
}

async function run(executable, args, { allowedCodes = [0], timeout = 120_000, extraEnvironment = {} } = {}) {
  const childEnvironment = { ...process.env, ...extraEnvironment };
  for (const key of ["POSTGRES_PASSWORD", "POSTGRES_APP_PASSWORD", "DATABASE_URL", "DIRECT_URL", "PGPASSWORD"]) {
    delete childEnvironment[key];
  }
  let output;
  let code = 0;
  try {
    output = await executeFile(executable, args, {
      cwd: workspace,
      env: childEnvironment,
      windowsHide: true,
      encoding: "utf8",
      timeout,
      maxBuffer: 2 * 1024 * 1024
    });
  } catch (error) {
    output = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    code = typeof error.code === "number" ? error.code : -1;
  }
  if (output.stdout || output.stderr) {
    await appendFile(launcherLog, `[${new Date().toISOString()}]\n${output.stdout}${output.stderr}\n`, "utf8");
  }
  if (!allowedCodes.includes(code)) fail("Uma ferramenta do PostgreSQL falhou. Consulte .cache/postgres/logs.");
  return { code, stdout: output.stdout };
}

async function archiveHash(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function ensureBinaries() {
  const executables = ["postgres.exe", "initdb.exe", "pg_ctl.exe"].map((name) => join(bin, name));
  if ((await Promise.all(executables.map(exists))).every(Boolean)) return;

  if (!(await exists(archive))) {
    console.info("Baixando o pacote oficial do PostgreSQL para o cache local.");
    const response = await fetch(SOURCE_URL, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) fail("Não foi possível baixar o pacote oficial do PostgreSQL.");
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partialArchive, { flags: "w" }));
    if (await archiveHash(partialArchive) !== SOURCE_SHA256) fail("O SHA-256 do pacote baixado não corresponde ao pacote oficial esperado.");
    await rename(partialArchive, archive);
  }
  if (await archiveHash(archive) !== SOURCE_SHA256) fail("O SHA-256 do arquivo em cache é inválido. A extração foi interrompida.");

  await mkdir(binaries, { recursive: true });
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const tar = join(system32, "tar.exe");
  if (await exists(tar)) {
    // The pinned SHA-256 authenticates this fixed archive. Extract only the
    // database runtime trees instead of unrelated bundled applications.
    await run(tar, ["-xf", archive, "-C", binaries, "pgsql/bin", "pgsql/lib", "pgsql/share"], { timeout: 600_000 });
  } else {
    const powershell = join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
    await run(powershell, [
      "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath $env:PREVISION_PG_ARCHIVE -DestinationPath $env:PREVISION_PG_BINARY_ROOT -Force"
    ], {
      timeout: 600_000,
      extraEnvironment: { PREVISION_PG_ARCHIVE: archive, PREVISION_PG_BINARY_ROOT: binaries }
    });
  }
  if (!(await Promise.all(executables.map(exists))).every(Boolean)) fail("A extração do PostgreSQL ficou incompleta. Consulte o cache local.");
}

function expectedMarker() {
  return {
    format: 1,
    kind: "prevision-portable-postgresql",
    environment: "development",
    databaseId: DATABASE_ID,
    workspace,
    dataDirectory: data,
    port: Number(PORT),
    adminUser: ADMIN
  };
}

async function assertOwnedCluster() {
  let marker;
  try {
    marker = JSON.parse(await readFile(markerFile, "utf8"));
  } catch {
    fail("O cluster local não possui identificação válida. Os dados foram preservados.");
  }
  const expected = expectedMarker();
  if (Object.entries(expected).some(([key, value]) => marker[key] !== value)) {
    fail("A identificação do cluster não corresponde a este projeto. Operação interrompida.");
  }
  if ((await readFile(join(data, "PG_VERSION"), "utf8")).trim() !== "17") {
    fail("A versão do cluster local não corresponde ao PostgreSQL 17.");
  }
}

async function initializeCluster(adminPassword) {
  if (await exists(join(data, "PG_VERSION"))) {
    await assertOwnedCluster();
    return;
  }
  if (await exists(markerFile) || (await exists(data) && (await readdir(data)).length > 0)) {
    fail("O diretório de dados existente não pode ser inicializado automaticamente. Os arquivos foram preservados.");
  }
  passwordFile = join(cache, `.initdb-password-${randomUUID()}.tmp`);
  await writeFile(passwordFile, `${adminPassword}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await run(join(bin, "initdb.exe"), [
      "-D", data, "-U", ADMIN, "--encoding=UTF8", "--locale=C", "--auth=scram-sha-256", "--pwfile", passwordFile
    ]);
  } finally {
    await unlink(passwordFile);
    passwordFile = undefined;
  }
  await writeFile(markerFile, `${JSON.stringify(expectedMarker(), null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function assertRunningCluster() {
  const lines = (await readFile(join(data, "postmaster.pid"), "utf8")).split(/\r?\n/);
  if (
    !/^[1-9][0-9]*$/.test(lines[0]?.trim() ?? "")
    || relative(data, resolve(lines[1]?.trim() ?? ".")) !== ""
    || lines[3]?.trim() !== PORT
    || lines[5]?.trim() !== HOST
  ) fail("O processo PostgreSQL não corresponde ao cluster e endereço locais esperados.");
}

async function withClient(database, user, password, action) {
  const client = new pg.Client({ host: HOST, port: Number(PORT), database, user, password, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    return await action(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function provision({ adminPassword, appPassword }) {
  await withClient("postgres", ADMIN, adminPassword, async (client) => {
    const identity = await client.query("SELECT current_setting('data_directory') AS directory");
    if (relative(data, resolve(identity.rows[0].directory)) !== "") fail("O servidor conectado pertence a outro diretório de dados.");

    // Avoid recording credential-bearing DDL or bind parameters in server logs.
    await client.query("SET log_statement = 'none'");
    await client.query("SET log_min_error_statement = 'panic'");
    await client.query("SET log_parameter_max_length = 0");
    await client.query("SET log_parameter_max_length_on_error = 0");

    if (!(await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [APP_USER])).rowCount) {
      const statement = await client.query(
        "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql",
        [APP_USER, appPassword]
      );
      await client.query(statement.rows[0].sql);
    }
    if (!(await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DATABASE])).rowCount) {
      const statement = await client.query("SELECT format('CREATE DATABASE %I OWNER %I', $1::text, $2::text) AS sql", [DATABASE, ADMIN]);
      await client.query(statement.rows[0].sql);
    }
    const grant = await client.query("SELECT format('GRANT CONNECT ON DATABASE %I TO %I', $1::text, $2::text) AS sql", [DATABASE, APP_USER]);
    await client.query(grant.rows[0].sql);
  });

  await withClient(DATABASE, ADMIN, adminPassword, async (client) => {
    const grant = await client.query("SELECT format('GRANT USAGE ON SCHEMA %I TO %I', $1::text, $2::text) AS sql", ["public", APP_USER]);
    await client.query(grant.rows[0].sql);
  });
  await withClient(DATABASE, APP_USER, appPassword, (client) => client.query("SELECT 1"));
}

async function main() {
  const command = process.argv[2];
  if (!["up", "down"].includes(command) || process.argv.length !== 3) fail("Use: node scripts/database/local-postgres.mjs up|down");
  const environment = readLocalEnvironment();
  for (const path of [cache, archive, partialArchive, binaries, bin, data, logs, launcherLog, serverLog, markerFile]) {
    await assertWorkspacePath(path);
  }

  if (command === "down" && !(await exists(markerFile)) && !(await exists(join(data, "PG_VERSION")))) {
    console.info("Nenhum cluster portátil identificado neste projeto.");
    return;
  }
  await mkdir(logs, { recursive: true });
  if (command === "up") {
    await ensureBinaries();
    await initializeCluster(environment.adminPassword);
  } else {
    await assertOwnedCluster();
    if (!(await exists(join(bin, "pg_ctl.exe")))) fail("O executável pg_ctl local não foi encontrado.");
  }

  const pgCtl = join(bin, "pg_ctl.exe");
  const status = await run(pgCtl, ["status", "-D", data], { allowedCodes: [0, 3] });
  if (command === "down") {
    if (status.code === 3) {
      console.info("O cluster portátil já está parado.");
      return;
    }
    await assertRunningCluster();
    await run(pgCtl, ["stop", "-D", data, "-m", "fast", "-w", "-t", "30"], { timeout: 45_000 });
    console.info("PostgreSQL portátil parado. Os dados foram preservados.");
    return;
  }

  if (status.code === 3) {
    await run(pgCtl, ["start", "-D", data, "-l", serverLog, "-o", `-p ${PORT} -h ${HOST}`, "-w", "-t", "30"], { timeout: 45_000 });
  }
  await assertRunningCluster();
  await provision(environment);
  console.info(`PostgreSQL portátil disponível em ${HOST}:${PORT}/${DATABASE}. Execute as migrations antes de usar a aplicação.`);
}

// Best-effort cleanup also covers interruption. Only the temporary password
// file created by this process is removed; data, archives and logs are retained.
process.once("exit", () => {
  if (passwordFile) {
    try { unlinkSync(passwordFile); } catch {}
  }
});
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));

main().catch((error) => {
  console.error(error instanceof LocalPostgresError
    ? error.message
    : "Não foi possível concluir a operação local. Consulte .cache/postgres/logs; dados e credenciais existentes foram preservados.");
  process.exitCode = 1;
});
