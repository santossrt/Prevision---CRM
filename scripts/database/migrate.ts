import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Client } from "pg";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment.ts";
import { reportDatabaseFailure } from "./shared.ts";

async function migrate() {
  const operation = process.argv[2];
  if (!["dev", "deploy", "status"].includes(operation)) throw new Error("Comando de migration inválido.");
  const extraArguments = process.argv.slice(3);
  for (let index = 0; index < extraArguments.length; index++) {
    const argument = extraArguments[index];
    if (operation === "dev" && argument === "--create-only") continue;
    if (operation === "dev" && ["--name", "-n"].includes(argument) && /^[a-zA-Z0-9_-]{1,80}$/.test(extraArguments[index + 1] ?? "")) {
      index++;
      continue;
    }
    throw new Error("Argumentos de migration inválidos. Somente --name e --create-only são aceitos em db:migrate.");
  }
  const environment = readEnvironment();
  assertLocalDevelopmentDatabase(environment);
  if (!environment.DIRECT_URL) throw new Error("Configure DIRECT_URL para administração local.");
  const database = new Client({ connectionString: environment.DIRECT_URL, connectionTimeoutMillis: 5000 });
  try {
    await database.connect();
    const exists = await database.query("SELECT to_regclass('public.environment_sentinel') IS NOT NULL AS present");
    if (exists.rows[0].present) {
      const identity = await database.query<{ environment: string; databaseId: string }>(
        'SELECT environment, database_id AS "databaseId" FROM environment_sentinel WHERE id = $1', ["primary"]
      );
      if (identity.rows.length > 0 || operation === "dev") assertDatabaseIdentity(environment, identity.rows[0] ?? null);
    } else if (operation === "dev") {
      assertDatabaseIdentity(environment, null);
    }
  } finally {
    await database.end();
  }
  const require = createRequire(import.meta.url);
  const cli = require.resolve("prisma/build/index.js");
  const child = spawn(process.execPath, [cli, "migrate", operation, ...extraArguments], { stdio: "inherit", shell: false });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  process.exitCode = code;
}

migrate().catch((error: unknown) => reportDatabaseFailure("Migration interrompida", error));
