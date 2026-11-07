import "server-only";
import { getToken } from "next-auth/jwt";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { getAuthSettings, sessionCookieName } from "./settings.ts";

export const identityInclude = { user: { include: { role: { include: { permissions: { include: { permission: true } } } }, accounts: { select: { provider: true } } } } } satisfies Prisma.LoginSessionInclude;
type SessionRecord = Prisma.LoginSessionGetPayload<{ include: typeof identityInclude }>;

export type Principal = {
  id: string; name: string | null; email: string; role: SessionRecord["user"]["role"]["code"];
  permissions: string[]; googleLinked: boolean; hasPassword: boolean; googleAccessAllowed: boolean;
  sessionId: string; sessionVersion: number;
};
export type PublicIdentity = Omit<Principal, "sessionId" | "sessionVersion">;

export function principalFromSession(record: SessionRecord, token: { sub?: string; version?: unknown }, now = new Date()): Principal | null {
  const { user } = record;
  const lastSeen = record.lastSeenAt ?? record.createdAt;
  if (!user.isActive || record.revokedAt || record.expiresAt <= now || token.sub !== user.id || token.version !== record.sessionVersion || user.sessionVersion !== record.sessionVersion || now.getTime() - lastSeen.getTime() > getAuthSettings().idleSeconds * 1000) return null;
  return {
    id: user.id, name: user.name, email: user.email, role: user.role.code,
    permissions: user.role.permissions.map(({ permission }) => permission.code),
    googleLinked: user.accounts.some(({ provider }) => provider === "google"),
    hasPassword: Boolean(user.passwordHash), googleAccessAllowed: user.googleAccessAllowed,
    sessionId: record.id, sessionVersion: record.sessionVersion
  };
}

export async function findSessionPrincipal(sid: unknown, token: { sub?: string; version?: unknown }, touch = true): Promise<Principal | null> {
  if (typeof sid !== "string" || !/^[0-9a-f-]{36}$/i.test(sid)) return null;
  await verifyDatabaseIdentity();
  const db = getDatabase();
  const record = await db.loginSession.findUnique({ where: { id: sid }, include: identityInclude });
  if (!record) return null;
  const principal = principalFromSession(record, token);
  if (principal && touch && Date.now() - (record.lastSeenAt ?? record.createdAt).getTime() > 60000) {
    await db.loginSession.updateMany({ where: { id: sid, revokedAt: null }, data: { lastSeenAt: new Date() } });
  }
  return principal;
}

export async function getRequestPrincipal(request?: Request): Promise<Principal | null> {
  const settings = getAuthSettings();
  // Request-only framework APIs stay lazy so the shared session validation
  // also runs from administrative workers without loading React's UI runtime.
  const requestHeaders = request?.headers ?? new Headers(await (await import("next/headers")).headers());
  const token = await getToken({ req: { headers: requestHeaders }, secret: settings.secret, cookieName: sessionCookieName(), salt: sessionCookieName() });
  if (!token) return null;
  return findSessionPrincipal(token.sid, { sub: token.sub, version: token.version });
}

export async function requireApiIdentity(request: Request): Promise<Principal> {
  const principal = await getRequestPrincipal(request);
  if (!principal) throw new ApplicationError("UNAUTHORIZED", "Entre novamente para continuar.");
  return principal;
}

export function publicIdentity(principal: Principal): PublicIdentity {
  const { sessionId: _sid, sessionVersion: _version, ...identity } = principal;
  return identity;
}

export async function requireIdentity(): Promise<PublicIdentity> {
  const principal = await getRequestPrincipal();
  if (!principal) return (await import("next/navigation")).redirect("/login");
  return publicIdentity(principal);
}
