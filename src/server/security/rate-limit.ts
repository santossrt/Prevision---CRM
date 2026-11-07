import "server-only";
import { createHmac } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/client.ts";
import { getDatabase } from "../database/client.ts";

export type RateLimitDatabase = Pick<PrismaClient, "$queryRaw">;
export type RateLimitResult = { allowed: boolean; retryAfter: number };

/** Fixed windows use the shared database clock and one atomic UPSERT. */
export async function consumeRateLimit(
  keyParts: string[],
  limit: number,
  windowSeconds: number,
  database?: RateLimitDatabase
): Promise<RateLimitResult> {
  const validWindow = Number.isSafeInteger(windowSeconds) && windowSeconds > 0 && windowSeconds <= 31_536_000;
  const denied = { allowed: false, retryAfter: validWindow ? windowSeconds : 60 };
  if (
    !validWindow
    || !Number.isSafeInteger(limit) || limit < 1 || limit >= 2_147_483_647
    || !Array.isArray(keyParts) || keyParts.length < 1 || keyParts.length > 16
    || keyParts.some((part) => typeof part !== "string" || part.length < 1 || part.length > 512)
  ) return denied;

  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) return denied;

  try {
    const key = createHmac("sha256", secret).update(JSON.stringify([windowSeconds, ...keyParts]), "utf8").digest("hex");
    const db = database ?? getDatabase();
    const rows = await db.$queryRaw<{ count: number; retryAfter: number }[]>`
      INSERT INTO "public"."rate_limit_buckets" ("key", "window_start", "count", "expires_at")
      SELECT ${key}, clock.window_start, 1,
             clock.window_start + interval '1 second' * ${windowSeconds}::integer
      FROM (
        SELECT to_timestamp(
          floor(extract(epoch FROM clock_timestamp()) / ${windowSeconds}::integer) * ${windowSeconds}::integer
        ) AS window_start
      ) AS clock
      ON CONFLICT ("key") DO UPDATE SET
        "window_start" = GREATEST("rate_limit_buckets"."window_start", EXCLUDED."window_start"),
        "count" = CASE
          WHEN "rate_limit_buckets"."window_start" >= EXCLUDED."window_start"
          THEN LEAST("rate_limit_buckets"."count"::bigint + 1, ${limit + 1}::bigint)::integer
          ELSE 1
        END,
        "expires_at" = GREATEST("rate_limit_buckets"."expires_at", EXCLUDED."expires_at")
      RETURNING "count", GREATEST(
        1, ceil(extract(epoch FROM ("expires_at" - clock_timestamp())))
      )::integer AS "retryAfter"
    `;
    const row = rows[0];
    if (!row || !Number.isInteger(row.count) || row.count < 1 || !Number.isInteger(row.retryAfter)) return denied;
    return row.count <= limit
      ? { allowed: true, retryAfter: 0 }
      : { allowed: false, retryAfter: Math.max(1, Math.min(windowSeconds, row.retryAfter)) };
  } catch {
    // A missing/unavailable shared store must never disable rate limiting.
    return denied;
  }
}
