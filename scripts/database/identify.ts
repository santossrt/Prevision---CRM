import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { getAdministrativeDatabase } from "./admin-client.ts";
import { reportDatabaseFailure } from "./shared.ts";

async function identify() {
  const environment = readEnvironment();
  assertLocalDevelopmentDatabase(environment);
  const database = getAdministrativeDatabase();
  try {
    const existing = await database.environmentSentinel.findUnique({ where: { id: "primary" } });
    if (existing) {
      assertDatabaseIdentity(environment, existing);
      console.info("Identidade local já registrada e válida; nenhuma alteração realizada.");
      return;
    }
    await database.environmentSentinel.create({ data: {
      id: "primary", environment: environment.APP_ENV, databaseId: environment.DATABASE_ID
    } });
    console.info("Identidade do banco local de desenvolvimento registrada.");
  } finally {
    await database.$disconnect();
  }
}

identify().catch((error: unknown) => reportDatabaseFailure("Identificação interrompida", error));
