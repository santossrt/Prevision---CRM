import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import type { MarkAllResult, NoticeResult, NotificationDTO, NotificationKind, NotificationList, NotificationSummary } from "../../lib/notifications/types.ts";
import { identityInclude, principalFromSession, type Principal } from "../auth/identity.ts";
import { assertPermission } from "../authorization/guard.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { notificationId, parseMarkAll, parseMarkRead, parseNotice, parseNotificationQuery } from "./validation.ts";

type Transaction = Prisma.TransactionClient;
type Record = {
  id: string; kind: NotificationKind; title: string; message: string; createdAt: Date | string;
  entityType: string | null; entityId: string | null; actorId: string | null; readAt: Date | string | null;
};
const notFound = () => new ApplicationError("NOT_FOUND", "Notificação não encontrada.");
const fields = Prisma.sql`n.id, n.kind, n.title, n.message, n.created_at AS "createdAt", n.entity_type AS "entityType", n.entity_id AS "entityId", n.actor_id AS "actorId", r.read_at AS "readAt"`;

function dto(record: Record): NotificationDTO {
  const id = record.entityId;
  const href = !id ? null : record.entityType === "Product" ? `/estoque?productId=${encodeURIComponent(id)}`
    : record.entityType === "StockMovement" ? `/estoque?movementId=${encodeURIComponent(id)}`
    : record.entityType === "Inventory" ? `/inventarios?id=${encodeURIComponent(id)}` : null;
  return { id: record.id, kind: record.kind, title: record.title, message: record.message, createdAt: new Date(record.createdAt).toISOString(), readAt: record.readAt ? new Date(record.readAt).toISOString() : null, href };
}
function visible(actor: Principal): Prisma.Sql {
  return actor.permissions.length
    ? Prisma.sql`(n.required_permission IS NULL OR n.required_permission IN (${Prisma.join(actor.permissions)}))`
    : Prisma.sql`n.required_permission IS NULL`;
}
/** The shared auth lock prevents permission/session mutations during this work;
 * READ COMMITTED revalidates with a fresh snapshot after waiting for that lock. */
async function authenticated<T>(actor: Principal, exclusive: boolean, work: (tx: Transaction, current: Principal) => Promise<T>): Promise<T> {
  await verifyDatabaseIdentity();
  return getDatabase().$transaction(async (tx) => {
    if (exclusive) await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026103002)`;
    else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103002)`;
    const session = await tx.loginSession.findUnique({ where: { id: actor.sessionId }, include: identityInclude });
    const current = session && principalFromSession(session, { sub: actor.id, version: actor.sessionVersion });
    if (!current) throw new ApplicationError("UNAUTHORIZED", "Entre novamente para continuar.");
    return work(tx, current);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
}

export async function getNotificationSummary(actor: Principal): Promise<NotificationSummary> {
  return authenticated(actor, false, async (tx, current) => {
    const asOf = new Date();
    const [counts] = await tx.$queryRaw<{ total: number; unreadCount: number }[]>`SELECT count(*)::int AS total, count(*) FILTER (WHERE r.read_at IS NULL)::int AS "unreadCount"
      FROM notifications n LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=${current.id}::uuid
      WHERE ${visible(current)} AND n.created_at<=${asOf}`;
    return { total: counts?.total ?? 0, unreadCount: counts?.unreadCount ?? 0, asOf: asOf.toISOString() };
  });
}

export async function listNotifications(actor: Principal, search: URLSearchParams): Promise<NotificationList> {
  const query = parseNotificationQuery(search);
  return authenticated(actor, false, async (tx, current) => {
    const asOf = new Date();
    const clauses: Prisma.Sql[] = [];
    if (query.read === "read") clauses.push(Prisma.sql`"readAt" IS NOT NULL`);
    if (query.read === "unread") clauses.push(Prisma.sql`"readAt" IS NULL`);
    if (query.kind) clauses.push(Prisma.sql`kind=${query.kind}::"public"."NotificationKind"`);
    if (query.from) clauses.push(Prisma.sql`"createdAt">=${new Date(query.from)}`);
    if (query.to) clauses.push(Prisma.sql`"createdAt"<=${new Date(query.to)}`);
    if (query.search) {
      const pattern = `%${query.search.replace(/[!%_]/gu, (character) => `!${character}`)}%`;
      clauses.push(Prisma.sql`(title ILIKE ${pattern} ESCAPE '!' OR message ILIKE ${pattern} ESCAPE '!')`);
    }
    const where = clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}` : Prisma.empty;
    // Counts and page share one PostgreSQL statement snapshot, including when a
    // different session inserts or marks a notification concurrently.
    const [result] = await tx.$queryRaw<{ total: number; unreadCount: number; items: Record[] }[]>`WITH visible AS (
      SELECT ${fields} FROM notifications n
      LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=${current.id}::uuid
      WHERE ${visible(current)} AND n.created_at<=${asOf}
    ), filtered AS (SELECT * FROM visible ${where}), page AS (
      SELECT * FROM filtered ORDER BY "createdAt" DESC,id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}
    ) SELECT (SELECT count(*)::int FROM filtered) AS total,
      (SELECT count(*) FILTER (WHERE "readAt" IS NULL)::int FROM visible) AS "unreadCount",
      coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "createdAt" DESC,id DESC) FROM page),'[]'::jsonb) AS items`;
    const total = result?.total ?? 0;
    return { items: (result?.items ?? []).map(dto), total, unreadCount: result?.unreadCount ?? 0, asOf: asOf.toISOString(), page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
  });
}

export async function markNotificationRead(actor: Principal, value: string, body: unknown): Promise<NotificationDTO> {
  const id = notificationId(value); parseMarkRead(body);
  return authenticated(actor, false, async (tx, current) => {
    const [record] = await tx.$queryRaw<Record[]>`SELECT ${fields} FROM notifications n
      LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=${current.id}::uuid
      WHERE n.id=${id}::uuid AND ${visible(current)}`;
    if (!record) throw notFound();
    if (record.readAt) return dto(record);
    await tx.$executeRaw`INSERT INTO notification_reads(notification_id,user_id,read_at)
      VALUES(${id}::uuid,${current.id}::uuid,clock_timestamp()) ON CONFLICT(notification_id,user_id) DO NOTHING`;
    const [read] = await tx.$queryRaw<{ readAt: Date }[]>`SELECT read_at AS "readAt" FROM notification_reads WHERE notification_id=${id}::uuid AND user_id=${current.id}::uuid`;
    if (!read) throw new ApplicationError("UNAVAILABLE", "Não foi possível conferir a leitura. Atualize as notificações.");
    return dto({ ...record, readAt: read.readAt });
  });
}

export async function markAllNotificationsRead(actor: Principal, body: unknown): Promise<MarkAllResult> {
  const through = parseMarkAll(body);
  return authenticated(actor, false, async (tx, current) => {
    const markedCount = await tx.$executeRaw`INSERT INTO notification_reads(notification_id,user_id,read_at)
      SELECT n.id,${current.id}::uuid,clock_timestamp() FROM notifications n WHERE ${visible(current)} AND n.created_at<=${through}
      ON CONFLICT(notification_id,user_id) DO NOTHING`;
    return { markedCount };
  });
}

export async function createAdministrativeNotice(actor: Principal, body: unknown): Promise<NoticeResult> {
  const input = parseNotice(body);
  return authenticated(actor, true, async (tx, current) => {
    if (current.role !== "ADMINISTRATOR") throw new ApplicationError("FORBIDDEN", "Somente administradores podem publicar avisos.");
    assertPermission(current, "settings.manage");
    const eventKey = `notice:${input.idempotencyKey}`;
    const [existing] = await tx.$queryRaw<Record[]>`SELECT ${fields} FROM notifications n
      LEFT JOIN notification_reads r ON r.notification_id=n.id AND r.user_id=${current.id}::uuid WHERE n.event_key=${eventKey}`;
    if (existing) {
      if (existing.actorId !== current.id || existing.kind !== "ADMIN_NOTICE" || existing.title !== input.title || existing.message !== input.message) {
        throw new ApplicationError("CONFLICT", "Esta identificação já foi utilizada para outro aviso. Confira o histórico antes de publicar novamente.");
      }
      return { notification: dto(existing), replayed: true };
    }
    const id = randomUUID(); const now = new Date();
    await tx.$executeRaw`INSERT INTO notifications(id,kind,title,message,event_key,actor_id,created_at)
      VALUES(${id}::uuid,'ADMIN_NOTICE',${input.title},${input.message},${eventKey},${current.id}::uuid,${now})`;
    await tx.auditEvent.create({ data: { actorId: current.id, action: "CREATE", module: "SYSTEM", entityType: "Notification", entityId: id, operationId: randomUUID(), origin: "notifications.notice.create", newValues: { title: input.title, kind: "ADMIN_NOTICE" } } });
    return { notification: dto({ id, kind: "ADMIN_NOTICE", title: input.title, message: input.message, createdAt: now, entityType: null, entityId: null, actorId: current.id, readAt: null }), replayed: false };
  });
}
