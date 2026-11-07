import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

config({ path: new URL("../.env", import.meta.url), quiet: true });
if (process.env.APP_ENV !== "development" || process.env.MAIL_TRANSPORT !== "local") {
  console.error("A caixa de teste só está disponível no desenvolvimento local.");
  process.exitCode = 1;
} else {
  try {
    const directory = new URL("../.cache/mail/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => /^\d+-[0-9a-f-]+\.json$/.test(name)).sort();
    const last = files.at(-1);
    if (!last) console.info("Nenhuma mensagem local recebida.");
    else {
      const message = JSON.parse(await readFile(new URL(last, directory), "utf8"));
      console.info(`Caixa de teste local — ${fileURLToPath(directory)}\nPara: ${message.to}\nAssunto: ${message.subject}\n\n${message.text}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") console.info("Nenhuma mensagem local recebida.");
    else { console.error("Não foi possível ler a caixa local."); process.exitCode = 1; }
  }
}
