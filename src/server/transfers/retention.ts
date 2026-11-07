import "server-only";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { Principal } from "../auth/identity.ts";
import { assertActorInTransaction } from "../authorization/guard.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";

export const transferPayloadLimits = {
  ownerCount: 100n,
  ownerBytes: 32n * 1024n * 1024n,
  globalBytes: 256n * 1024n * 1024n
} as const;

type Usage = { ownerCount: bigint; ownerBytes: bigint; globalBytes: bigint; incomingBytes: bigint };
const unavailable = () => new ApplicationError("UNAVAILABLE", "Não foi possível conferir o limite das prévias. Tente novamente.");

/** Acquire after authorization/catalog locks. A batch retires at most 100
 * temporary payloads; callers commit it independently of quota admission so
 * legacy expired data is removed even while a new preview is refused. */
export async function purgeExpiredTransferPayloads(tx: Prisma.TransactionClient): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(202611060012::bigint)`;
  // Each successful creation retires up to 100 expired payloads. Metadata and
  // its audit references remain immutable; database triggers enforce this
  // narrow exception even for callers with administrative SQL privileges.
  const [result] = await tx.$queryRaw<{ cleared: bigint }[]>`WITH expired AS MATERIALIZED (
    SELECT kind,id FROM (
      SELECT 'export'::text AS kind,id,expires_at FROM public.report_exports
        WHERE payload<>'{}'::jsonb AND expires_at<=clock_timestamp()
      UNION ALL
      SELECT 'import'::text AS kind,id,expires_at FROM public.product_imports
        WHERE status='PREVIEW' AND payload<>'{}'::jsonb AND expires_at<=clock_timestamp()
    ) candidates ORDER BY expires_at,id,kind LIMIT 100
  ), cleared_exports AS (
    UPDATE public.report_exports SET payload='{}'::jsonb
      WHERE id IN(SELECT id FROM expired WHERE kind='export')
        AND payload<>'{}'::jsonb AND expires_at<=clock_timestamp() RETURNING id
  ), cleared_imports AS (UPDATE public.product_imports SET payload='{}'::jsonb
    WHERE id IN(SELECT id FROM expired WHERE kind='import') AND status='PREVIEW'
      AND payload<>'{}'::jsonb AND expires_at<=clock_timestamp() RETURNING id)
    SELECT ((SELECT count(*) FROM cleared_exports)+(SELECT count(*) FROM cleared_imports))::bigint AS cleared`;
  if (!result || typeof result.cleared !== "bigint" || result.cleared < 0n || result.cleared > 100n) throw unavailable();
  return Number(result.cleared);
}

/** Only a currently authorized creator may initiate request-side maintenance.
 * Its separate commit guarantees progress when old payloads exceed quotas. */
export async function prepareTransferRetention(actor: Principal, permissions: readonly string[]): Promise<void> {
  await verifyDatabaseIdentity();
  await getDatabase().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103002)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103003)`;
    for (const permission of permissions) await assertActorInTransaction(tx, actor, permission);
    await purgeExpiredTransferPayloads(tx);
  }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 });
}

/** Call inside the creation transaction, after authorization/catalog locks.
 * The quota lock stays held until the payload insert commits or rolls back.
 * Count every retained temporary payload, including any expired backlog.
 * Completed imports are business history and do not consume preview quota. */
export async function reserveTransferPayload(tx: Prisma.TransactionClient, ownerId: string, payload: Prisma.InputJsonValue): Promise<void> {
  const serialized = JSON.stringify(payload);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(202611060012::bigint)`;
  const [usage] = await tx.$queryRaw<Usage[]>`WITH retained AS (
    SELECT owner_id,octet_length(payload::text)::bigint AS bytes FROM public.report_exports
      WHERE payload<>'{}'::jsonb
    UNION ALL
    SELECT owner_id,octet_length(payload::text)::bigint AS bytes FROM public.product_imports
      WHERE status='PREVIEW' AND payload<>'{}'::jsonb
  ) SELECT count(*) FILTER(WHERE owner_id=${ownerId}::uuid)::bigint AS "ownerCount",
      coalesce(sum(bytes) FILTER(WHERE owner_id=${ownerId}::uuid),0)::bigint AS "ownerBytes",
      coalesce(sum(bytes),0)::bigint AS "globalBytes",
      octet_length(${serialized}::jsonb::text)::bigint AS "incomingBytes" FROM retained`;
  if (!usage || Object.values(usage).some((value) => typeof value !== "bigint" || value < 0n)) throw unavailable();
  if (usage.ownerCount >= transferPayloadLimits.ownerCount || usage.ownerBytes + usage.incomingBytes > transferPayloadLimits.ownerBytes) {
    throw new ApplicationError("VALIDATION", "Você atingiu o limite de prévias disponíveis. Aguarde a expiração de uma prévia antes de gerar outra.");
  }
  if (usage.globalBytes + usage.incomingBytes > transferPayloadLimits.globalBytes) {
    throw new ApplicationError("UNAVAILABLE", "Há muitas prévias disponíveis neste ambiente. Aguarde a expiração de algumas antes de gerar outra.");
  }
}
