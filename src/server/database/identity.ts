import "server-only";
import { assertDatabaseIdentity, readEnvironment } from "../config/environment.ts";
import { getDatabase } from "./client.ts";

export async function verifyDatabaseIdentity(): Promise<void> {
  const identity = await getDatabase().environmentSentinel.findUnique({ where: { id: "primary" } });
  assertDatabaseIdentity(readEnvironment(), identity);
}
