import { config } from "dotenv";
import { getDatabase } from "../../src/server/database/client.ts";
import { processPasswordResetJobs } from "../../src/server/auth/password-reset-jobs.ts";

config({ path: ".env", quiet: true });

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || arguments_.length === 1 && !/^--limit=\d{1,2}$/u.test(arguments_[0])) throw new Error("arguments");
  const limit = arguments_.length ? Number(arguments_[0].slice("--limit=".length)) : 10;
  const result = await processPasswordResetJobs({ limit });
  console.info(`Recuperação: ${result.processed} solicitações processadas; ${result.failed} tentativas não concluídas.`);
  if (result.failed > 0) process.exitCode = 1;
}

main().catch(() => {
  console.error("Não foi possível processar a fila de recuperação. Confira a identidade do ambiente, as migrations e o limite de 1 a 25; dados privados omitidos.");
  process.exitCode = 1;
}).finally(async () => { try { await getDatabase().$disconnect(); } catch { /* Configuration failures have already been reported without private data. */ } });
