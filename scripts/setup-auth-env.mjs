import { randomBytes } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { parse } from "dotenv";

const path = new URL("../.env", import.meta.url);
try {
  const existing = parse(await readFile(path, "utf8"));
  const defaults = {
    AUTH_SECRET: randomBytes(48).toString("hex"),
    AUTH_URL: "http://127.0.0.1:3000",
    MAIL_TRANSPORT: "local",
    MAIL_FROM: "Prevision <nao-responda@example.invalid>"
  };
  const missing = Object.entries(defaults).filter(([key]) => !(key in existing));
  if (missing.length) await appendFile(path, `\n# Autenticação local; não versionar segredos.\n${missing.map(([key, value]) => `${key}=${value}`).join("\n")}\n`, "utf8");
  console.info("Configuração de autenticação preparada. Valores existentes foram preservados e nenhum segredo foi exibido.");
} catch {
  console.error("Prepare o .env com npm run env:setup antes de configurar a autenticação.");
  process.exitCode = 1;
}
