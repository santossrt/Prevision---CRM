import "server-only";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { ThemeMode, UserPreferenceDTO } from "../../lib/preferences/types.ts";
import type { Principal } from "../auth/identity.ts";
import { identityInclude, principalFromSession } from "../auth/identity.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { parsePreferenceUpdate, validTheme } from "./validation.ts";

async function currentActor(tx: Prisma.TransactionClient, actor: Principal) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103002)`;
  const record = await tx.loginSession.findUnique({ where: { id: actor.sessionId }, include: identityInclude });
  const current = record && principalFromSession(record, { sub: actor.id, version: actor.sessionVersion });
  if (!current) throw new ApplicationError("UNAUTHORIZED", "Entre novamente para continuar.");
}

function dto(record: { theme: string; version: number } | null): UserPreferenceDTO {
  if (!record) return { theme: "system", version: 0 };
  if (!validTheme(record.theme)) throw new ApplicationError("UNAVAILABLE", "Não foi possível consultar o tema salvo. Tente novamente.");
  return { theme: record.theme as ThemeMode, version: record.version };
}

export async function getUserPreference(actor: Principal): Promise<UserPreferenceDTO> {
  await verifyDatabaseIdentity();
  return getDatabase().$transaction(async (tx) => {
    await currentActor(tx, actor);
    return dto(await tx.userPreference.findUnique({ where: { userId: actor.id } }));
  }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 });
}

export async function updateUserPreference(actor: Principal, body: unknown): Promise<UserPreferenceDTO> {
  const input = parsePreferenceUpdate(body);
  await verifyDatabaseIdentity();
  return getDatabase().$transaction(async (tx) => {
    await currentActor(tx, actor);
    // Serialize this user's first write as well as later edits. The namespace
    // is separate from authorization and stock locks and does not store state.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026110108, hashtext(${actor.id}))`;
    await tx.userPreference.upsert({ where: { userId: actor.id }, create: { userId: actor.id, theme: "system" }, update: {} });
    const changed = await tx.userPreference.updateMany({
      where: { userId: actor.id, version: input.expectedVersion },
      data: { theme: input.theme, version: { increment: 1 } }
    });
    if (changed.count !== 1) throw new ApplicationError("CONFLICT", "Suas preferências foram alteradas em outra aba ou dispositivo. Recarregue antes de salvar novamente.");
    return { theme: input.theme, version: input.expectedVersion + 1 };
  }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 });
}
