import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { readEnvironment } from "../../src/server/config/environment.ts";

export function getAdministrativeDatabase() {
  const environment = readEnvironment();
  if (!environment.DIRECT_URL) throw new Error("Configure DIRECT_URL para administração local.");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: environment.DIRECT_URL, max: 1, connectionTimeoutMillis: 5000 }) });
}
