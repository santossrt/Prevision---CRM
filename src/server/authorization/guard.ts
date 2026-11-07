import "server-only";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { Principal } from "../auth/identity.ts";
import { identityInclude, principalFromSession } from "../auth/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";

export function assertPermission(principal: Pick<Principal, "permissions">, permission: string) {
  if (!principal.permissions.includes(permission)) throw new ApplicationError("FORBIDDEN", "Você não tem permissão para esta operação.");
}

export async function assertActorInTransaction(tx: Prisma.TransactionClient, actor: Principal, permission: string) {
  const record = await tx.loginSession.findUnique({ where: { id: actor.sessionId }, include: identityInclude });
  const current = record && principalFromSession(record, { sub: actor.id, version: actor.sessionVersion });
  if (!current) throw new ApplicationError("UNAUTHORIZED", "Entre novamente para continuar.");
  assertPermission(current, permission);
}
