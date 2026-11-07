import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const adminPassword = randomBytes(32).toString("hex");
const appPassword = randomBytes(32).toString("hex");
const contents = [
  "# Configuração local gerada; arquivo ignorado pelo Git.",
  "APP_ENV=development",
  "DATABASE_ID=prevision-local-development",
  "POSTGRES_DB=prevision_dev",
  "POSTGRES_USER=prevision_admin",
  "POSTGRES_PORT=55432",
  `POSTGRES_PASSWORD=${adminPassword}`,
  `POSTGRES_APP_PASSWORD=${appPassword}`,
  `DATABASE_URL=postgresql://prevision_app:${appPassword}@127.0.0.1:55432/prevision_dev?schema=public`,
  `DIRECT_URL=postgresql://prevision_admin:${adminPassword}@127.0.0.1:55432/prevision_dev?schema=public`,
  ""
].join("\n");

try {
  await writeFile(new URL("../.env", import.meta.url), contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.info(".env local criado com senhas aleatórias. Nenhuma credencial foi exibida.");
} catch (error) {
  if (error?.code === "EEXIST") {
    console.info(".env já existe e foi preservado.");
  } else {
    console.error("Não foi possível criar o .env local.");
    process.exitCode = 1;
  }
}
