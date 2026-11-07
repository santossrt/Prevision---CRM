import "server-only";
import { Prisma } from "../../generated/prisma/client.ts";
import { AuditAction, AuditModule } from "../../generated/prisma/enums.ts";
import type { AuditEventDTO, AuditEventSummaryDTO, AuditList, AuditOptions } from "../../lib/audit/types.ts";
import { actionLabel, moduleLabel } from "../../lib/audit/labels.ts";
import type { Principal } from "../auth/identity.ts";
import { assertActorInTransaction, assertPermission } from "../authorization/guard.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { sanitizeAuditOrigin, sanitizeAuditSnapshot } from "./sanitize.ts";
import { auditIdSchema, parseAuditQuery } from "./validation.ts";

const summarySelect = {
  id: true, actor: { select: { id: true, name: true } }, action: true, module: true,
  entityType: true, entityId: true, origin: true, operationId: true, createdAt: true
} as const satisfies Prisma.AuditEventSelect;
type Summary = Prisma.AuditEventGetPayload<{ select: typeof summarySelect }>;
const toSummary = (event: Summary): AuditEventSummaryDTO => ({
  id: event.id, actor: event.actor, action: event.action, module: event.module, entityType: event.entityType,
  entityId: event.entityId, origin: sanitizeAuditOrigin(event.origin), operationId: event.operationId, createdAt: event.createdAt.toISOString()
});
async function read<T>(actor: Principal, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  assertPermission(actor, "audit.read");
  await verifyDatabaseIdentity();
  return getDatabase().$transaction(async (tx) => {
    await assertActorInTransaction(tx, actor, "audit.read");
    return work(tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 15000 });
}

export async function listAuditEvents(actor: Principal, search: URLSearchParams): Promise<AuditList> {
  assertPermission(actor, "audit.read");
  const query = parseAuditQuery(search);
  return read(actor, async (tx) => {
    const clauses: Prisma.Sql[] = [];
    if (query.actorId) clauses.push(Prisma.sql`a.actor_id = ${query.actorId}::uuid`);
    if (query.module) clauses.push(Prisma.sql`a.module = ${query.module}::"AuditModule"`);
    if (query.action) clauses.push(Prisma.sql`a.action = ${query.action}::"AuditAction"`);
    if (query.entityType) clauses.push(Prisma.sql`a.entity_type = ${query.entityType}`);
    if (query.entityId) clauses.push(Prisma.sql`a.entity_id = ${query.entityId}`);
    if (query.operationId) clauses.push(Prisma.sql`a.operation_id = ${query.operationId}::uuid`);
    if (query.from) clauses.push(Prisma.sql`a.created_at >= ${new Date(query.from)}::timestamptz`);
    if (query.to) clauses.push(Prisma.sql`a.created_at <= ${new Date(query.to)}::timestamptz`);
    if (query.search) {
      const pattern = `%${query.search.replace(/[!%_]/gu, (character) => `!${character}`)}%`;
      clauses.push(Prisma.sql`(a.entity_type ILIKE ${pattern} ESCAPE '!' OR a.entity_id ILIKE ${pattern} ESCAPE '!'
        OR a.operation_id::text ILIKE ${pattern} ESCAPE '!' OR u.name ILIKE ${pattern} ESCAPE '!')`);
    }
    const where = clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}` : Prisma.empty;
    const [count] = await tx.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id ${where}`;
    const ids = await tx.$queryRaw<{ id: string }[]>`SELECT a.id FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id ${where}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
    const events = await tx.auditEvent.findMany({ where: { id: { in: ids.map((entry) => entry.id) } }, select: summarySelect });
    const byId = new Map(events.map((event) => [event.id, event]));
    const total = count?.total ?? 0;
    return { items: ids.map(({ id }) => toSummary(byId.get(id)!)), total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
  });
}

export async function getAuditEvent(actor: Principal, eventId: string): Promise<AuditEventDTO> {
  assertPermission(actor, "audit.read");
  const result = auditIdSchema.safeParse(eventId);
  if (!result.success) throw new ApplicationError("VALIDATION", "Identificador de auditoria inválido.");
  return read(actor, async (tx) => {
    const event = await tx.auditEvent.findUnique({ where: { id: result.data }, select: { ...summarySelect, previousValues: true, newValues: true } });
    if (!event) throw new ApplicationError("NOT_FOUND", "Registro de auditoria não encontrado.");
    return { ...toSummary(event), previousValues: sanitizeAuditSnapshot(event.previousValues), newValues: sanitizeAuditSnapshot(event.newValues) };
  });
}

export async function getAuditOptions(actor: Principal): Promise<AuditOptions> {
  return read(actor, async (tx) => {
    const actors = await tx.$queryRaw<{ id: string; name: string | null }[]>`SELECT u.id, u.name FROM users u
      WHERE EXISTS (SELECT 1 FROM audit_events a WHERE a.actor_id = u.id) ORDER BY u.name ASC NULLS LAST, u.id ASC`;
    const types = await tx.$queryRaw<{ entityType: string }[]>`SELECT DISTINCT entity_type AS "entityType" FROM audit_events ORDER BY entity_type ASC`;
    return {
      actors, entityTypes: types.map((row) => row.entityType),
      modules: Object.values(AuditModule).map((value) => ({ value, label: moduleLabel(value) })),
      actions: Object.values(AuditAction).map((value) => ({ value, label: actionLabel(value) }))
    };
  });
}
