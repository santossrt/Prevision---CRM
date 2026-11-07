import "server-only";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getDatabase } from "../database/client.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { getAuthSettings } from "./settings.ts";

// Shared with user-management writes: permission changes, password resets and
// authentication must observe one another before issuing a new session/grant.
export async function lockAuthState(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026103002)`;
}

export async function createLoginSession(userId: string, provider: string, origin: string, expectedSessionVersion?: number) {
  return getDatabase().$transaction(async (tx) => {
    await lockAuthState(tx);
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user?.isActive) throw new ApplicationError("UNAUTHORIZED", "Acesso não autorizado.");
    if (provider === "credentials" && (!user.passwordHash || expectedSessionVersion !== user.sessionVersion)) {
      throw new ApplicationError("UNAUTHORIZED", "Entre novamente para continuar.");
    }
    if (provider === "google" && (!user.googleAccessAllowed || !await tx.account.findFirst({ where: { userId, provider: "google" }, select: { id: true } }))) {
      throw new ApplicationError("UNAUTHORIZED", "Acesso não autorizado.");
    }
    if (provider !== "credentials" && provider !== "google") throw new ApplicationError("UNAUTHORIZED", "Acesso não autorizado.");
    const now = new Date();
    const session = await tx.loginSession.create({ data: { userId, sessionVersion: user.sessionVersion, createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + getAuthSettings().sessionSeconds * 1000) } });
    await tx.auditEvent.create({ data: { actorId: userId, action: "LOGIN_SUCCESS", module: "AUTH", entityType: "LoginSession", entityId: session.id, origin, newValues: { provider } } });
    return session;
  });
}

export async function revokeLoginSession(sid: unknown, userId: unknown) {
  if (typeof sid !== "string" || typeof userId !== "string") return;
  await getDatabase().$transaction(async (tx) => {
    await lockAuthState(tx);
    const revoked = await tx.loginSession.updateMany({ where: { id: sid, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (revoked.count) await tx.auditEvent.create({ data: { actorId: userId, action: "LOGOUT", module: "AUTH", entityType: "LoginSession", entityId: sid } });
  });
}
