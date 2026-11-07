import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { purgeExpiredTransferPayloads } from "../../src/server/transfers/retention.ts";
import { getAdministrativeDatabase } from "./admin-client.ts";
import { reportDatabaseFailure } from "./shared.ts";

async function purge() {
  if (process.argv.length !== 2) throw new Error("O expurgo não aceita destinos ou argumentos.");
  const environment = readEnvironment();
  assertLocalDevelopmentDatabase(environment);
  const database = getAdministrativeDatabase();
  let total = 0;
  try {
    assertDatabaseIdentity(environment, await database.environmentSentinel.findUnique({ where: { id: "primary" } }));
    // Bound each commit and the entire maintenance invocation. No table or
    // database is dropped and completed imports/immutable metadata survive.
    for (let batch = 0; batch < 1000; batch++) {
      const cleared = await database.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103002)`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103003)`;
        return purgeExpiredTransferPayloads(tx);
      }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 });
      total += cleared;
      if (cleared === 0) break;
    }
    console.info(`${total} conteúdos temporários expirados removidos; metadados e importações concluídas preservados.`);
  } finally { await database.$disconnect(); }
}

purge().catch((error: unknown) => reportDatabaseFailure("Limpeza de prévias interrompida", error));
