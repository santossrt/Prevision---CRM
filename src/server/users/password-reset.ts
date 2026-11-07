import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import type { Principal } from "../auth/identity.ts";
import { hashAccessToken } from "../auth/access-tokens.ts";
import { getAuthSettings } from "../auth/settings.ts";
import { lockAuthState } from "../auth/sessions.ts";
import { assertActorInTransaction, assertPermission } from "../authorization/guard.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { deliverAccessEmail } from "../mail/delivery.ts";

const administratorOnly = () => new ApplicationError("FORBIDDEN", "Somente administradores podem solicitar redefinições de senha pelo gerenciamento de usuários.");

/** The administrator authorizes a reset; only the recipient chooses the password. */
export async function requestAdminPasswordReset(actor: Principal, userId: string): Promise<{ sent: true }> {
  if (actor.role !== "ADMINISTRATOR") throw administratorOnly();
  assertPermission(actor, "users.manage");
  const targetId = z.string().uuid().safeParse(userId);
  if (!targetId.success) throw new ApplicationError("VALIDATION", "Identificador de usuário inválido.");
  const settings = getAuthSettings();
  await verifyDatabaseIdentity();
  const db = getDatabase();
  const operationId = randomUUID();
  const issued = await db.$transaction(async (tx) => {
    await lockAuthState(tx);
    await assertActorInTransaction(tx, actor, "users.manage");
    // A role supplied by the request-time principal cannot authorize a queued
    // operation after the administrator has been demoted.
    const administrator = await tx.user.findUnique({ where: { id: actor.id }, select: { role: { select: { code: true } } } });
    if (administrator?.role.code !== "ADMINISTRATOR") throw administratorOnly();
    const user = await tx.user.findUnique({ where: { id: targetId.data }, select: { id: true, email: true, isActive: true } });
    if (!user) throw new ApplicationError("NOT_FOUND", "Usuário não encontrado.");
    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    await tx.accessToken.updateMany({
      where: { userId: user.id, purpose: { in: ["PASSWORD_SETUP", "PASSWORD_RESET", "ADMIN_PASSWORD_RESET", "GOOGLE_LINK"] }, usedAt: null, revokedAt: null },
      data: { revokedAt: now }
    });
    const record = await tx.accessToken.create({
      data: { userId: user.id, purpose: "ADMIN_PASSWORD_RESET", tokenHash: hashAccessToken(token), createdAt: now, expiresAt: new Date(now.getTime() + 30 * 60 * 1000) },
      select: { id: true }
    });
    await tx.auditEvent.create({ data: {
      actorId: actor.id, action: "UPDATE", module: "USERS", entityType: "User", entityId: user.id,
      origin: "users.admin_password_reset", operationId,
      newValues: { passwordResetRequested: true, administrativeReset: true, isActive: user.isActive }
    } });
    return { token, tokenId: record.id, email: user.email, userId: user.id };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });

  const url = new URL("/redefinir-senha", settings.url);
  url.searchParams.set("token", issued.token);
  try {
    await deliverAccessEmail(issued.email, "Redefina sua senha do Prevision", `Um administrador solicitou a redefinição da sua senha do Prevision. Para escolher uma nova senha, utilize:\n\n${url}\n\nEste link expira em 30 minutos e só pode ser utilizado uma vez. A nova senha encerra as sessões anteriores. A redefinição não ativa uma conta inativa nem remove o vínculo com Google. Se não esperava esta solicitação, fale com o administrador.`);
  } catch {
    // Revoke this request's link when delivery cannot be confirmed. A later
    // request is never revoked: cleanup targets only our token ID.
    await db.$transaction(async (tx) => {
      await lockAuthState(tx);
      await tx.accessToken.updateMany({ where: { id: issued.tokenId, userId: issued.userId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditEvent.create({ data: {
        actorId: actor.id, action: "UPDATE", module: "USERS", entityType: "User", entityId: issued.userId,
        origin: "users.admin_password_reset.delivery_failed", operationId,
        newValues: { passwordResetDeliveryFailed: true, administrativeReset: true }
      } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 }).catch(() => {});
    throw new ApplicationError("UNAVAILABLE", "Não foi possível enviar as instruções de redefinição. Tente novamente.");
  }
  return { sent: true };
}
