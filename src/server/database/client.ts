import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.ts";
import { readEnvironment } from "../config/environment.ts";
import { databaseConnectionOptions } from "./connection-options.ts";

const databaseGlobal = globalThis as unknown as {
  previsionDatabase?: PrismaClient;
  previsionDatabaseClients?: WeakMap<typeof PrismaClient, PrismaClient>;
};

function createDatabase(): PrismaClient {
  const environment = readEnvironment();
  const adapter = new PrismaPg({ ...databaseConnectionOptions(environment), max: 3, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
  return new PrismaClient({ adapter });
}

/** Instanciado sob demanda; nenhum acesso ao banco ocorre no build. */
export function getDatabase(): PrismaClient {
  // Production deploys restart the process and do not use HMR. Preserve one
  // pool per process even when server bundles have distinct constructors.
  if (process.env.NODE_ENV === "production") return databaseGlobal.previsionDatabase ??= createDatabase();

  const clients = databaseGlobal.previsionDatabaseClients ??= new WeakMap();
  let database = clients.get(PrismaClient);
  if (!database) {
    database = createDatabase();
    // HMR can replace the generated constructor after a schema change. Each
    // constructor must retain its own client, including across server bundles.
    // Do not disconnect older clients here: requests may still be using them.
    // Their idle connections expire through the adapter's timeout.
    clients.set(PrismaClient, database);
  }
  return database;
}
