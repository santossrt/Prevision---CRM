import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { decryptResetJobEmail, encryptResetJobEmail } from "../mail/job-crypto.ts";
import { requestPasswordReset } from "./access-tokens.ts";
import { emailSchema } from "./settings.ts";

export const resetJobLimits = { active: 256, lifetimeSeconds: 900, leaseSeconds: 60, attempts: 3, maintenanceRows: 64 } as const;
type ClaimedJob = { id: string; payload: string; lockedBy: string; attempts: number };
const unavailable = () => new ApplicationError("UNAVAILABLE", "Não foi possível solicitar a recuperação neste momento. Tente novamente.");

/** Bounded maintenance is safe to repeat. Terminal rows carry no address. */
async function maintain(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`WITH expired AS (
    SELECT id FROM public.password_reset_jobs
    WHERE status IN ('PENDING','PROCESSING') AND
      (expires_at<=clock_timestamp() OR (status='PROCESSING' AND lease_until<=clock_timestamp() AND attempts>=${resetJobLimits.attempts}))
    ORDER BY created_at,id LIMIT ${resetJobLimits.maintenanceRows} FOR UPDATE SKIP LOCKED
  ) UPDATE public.password_reset_jobs j SET status='FAILED',payload=NULL,locked_by=NULL,lease_until=NULL,processed_at=clock_timestamp()
    FROM expired WHERE j.id=expired.id`;
  await tx.$executeRaw`DELETE FROM public.password_reset_jobs WHERE id IN (
    SELECT id FROM public.password_reset_jobs WHERE status IN ('COMPLETED','FAILED') AND processed_at<clock_timestamp()-interval '1 day'
    ORDER BY processed_at,id LIMIT ${resetJobLimits.maintenanceRows} FOR UPDATE SKIP LOCKED
  )`;
}

/** The public path always performs the same encrypted insert. Account lookup
 * and all email delivery belong exclusively to the worker after the response. */
export async function enqueuePasswordReset(email: string): Promise<string> {
  const normalized = emailSchema.parse(email); const id = randomUUID();
  const payload = encryptResetJobEmail(id, normalized);
  await verifyDatabaseIdentity();
  await getDatabase().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026110705)`;
    await maintain(tx);
    const [quota] = await tx.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM public.password_reset_jobs
      WHERE status IN ('PENDING','PROCESSING') AND expires_at>clock_timestamp()`;
    if (!quota || !Number.isInteger(quota.count) || quota.count < 0 || quota.count >= resetJobLimits.active) throw unavailable();
    await tx.$executeRaw`INSERT INTO public.password_reset_jobs(id,payload,status,attempts,available_at,expires_at,created_at)
      SELECT ${id}::uuid,${payload},'PENDING',0,t.now,t.now+interval '1 second'*${resetJobLimits.lifetimeSeconds},t.now
      FROM (SELECT clock_timestamp() AS now) t`;
  }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 });
  return id;
}

async function claim(jobId?: string): Promise<ClaimedJob | null> {
  const lockedBy = randomUUID();
  return getDatabase().$transaction(async (tx) => {
    await maintain(tx);
    const target = jobId ? Prisma.sql`AND id=${jobId}::uuid` : Prisma.empty;
    const [job] = await tx.$queryRaw<ClaimedJob[]>`WITH candidate AS (
      SELECT id FROM public.password_reset_jobs WHERE expires_at>clock_timestamp() AND attempts<${resetJobLimits.attempts}
      AND ((status='PENDING' AND available_at<=clock_timestamp()) OR (status='PROCESSING' AND lease_until<=clock_timestamp()))
      ${target} ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE public.password_reset_jobs j SET status='PROCESSING',attempts=j.attempts+1,locked_by=${lockedBy}::uuid,
      lease_until=clock_timestamp()+interval '1 second'*${resetJobLimits.leaseSeconds}
      FROM candidate WHERE j.id=candidate.id
      RETURNING j.id,j.payload,j.locked_by AS "lockedBy",j.attempts`;
    return job ?? null;
  }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10000 });
}

function heartbeat(job: ClaimedJob) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; running = true;
    void getDatabase().$executeRaw`UPDATE public.password_reset_jobs SET lease_until=clock_timestamp()+interval '1 second'*${resetJobLimits.leaseSeconds}
      WHERE id=${job.id}::uuid AND locked_by=${job.lockedBy}::uuid AND status='PROCESSING' AND expires_at>clock_timestamp()`
      .catch(() => { /* A later worker can recover the lease; no private error is logged. */ })
      .finally(() => { running = false; });
  }, 20000);
  timer.unref();
  return () => clearInterval(timer);
}

async function finish(job: ClaimedJob, status: "COMPLETED" | "FAILED" = "COMPLETED") {
  return getDatabase().$executeRaw`UPDATE public.password_reset_jobs SET status=${status},payload=NULL,locked_by=NULL,lease_until=NULL,processed_at=clock_timestamp()
    WHERE id=${job.id}::uuid AND locked_by=${job.lockedBy}::uuid AND status='PROCESSING'`;
}

async function retry(job: ClaimedJob) {
  const delaySeconds = 30 * job.attempts;
  await getDatabase().$executeRaw`UPDATE public.password_reset_jobs SET
    status=CASE WHEN attempts>=${resetJobLimits.attempts} OR expires_at<=clock_timestamp()+interval '1 second'*${delaySeconds} THEN 'FAILED' ELSE 'PENDING' END,
    payload=CASE WHEN attempts>=${resetJobLimits.attempts} OR expires_at<=clock_timestamp()+interval '1 second'*${delaySeconds} THEN NULL ELSE payload END,
    processed_at=CASE WHEN attempts>=${resetJobLimits.attempts} OR expires_at<=clock_timestamp()+interval '1 second'*${delaySeconds} THEN clock_timestamp() ELSE NULL END,
    available_at=LEAST(expires_at,clock_timestamp()+interval '1 second'*${delaySeconds}),locked_by=NULL,lease_until=NULL
    WHERE id=${job.id}::uuid AND locked_by=${job.lockedBy}::uuid AND status='PROCESSING'`;
}

/** Delivery is at least once: a process dying after SMTP accepts a message and
 * before completion is persisted may retry. The existing reset flow revokes
 * older reset grants, so only the most recently issued link remains valid. */
export async function processPasswordResetJobs(options: { limit?: number; jobId?: string } = {}): Promise<{ processed: number; failed: number }> {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 25 || options.jobId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(options.jobId)) {
    throw new ApplicationError("VALIDATION", "Informe um limite de 1 a 25 solicitações para processar.");
  }
  await verifyDatabaseIdentity();
  const result = { processed: 0, failed: 0 };
  for (let index = 0; index < limit; index++) {
    const job = await claim(options.jobId);
    if (!job) break;
    const stopHeartbeat = heartbeat(job);
    try {
      let email: string;
      try { email = decryptResetJobEmail(job.id, job.payload); }
      catch { await finish(job, "FAILED"); result.failed++; continue; }
      await requestPasswordReset(email);
      if (await finish(job) === 1) result.processed++;
      else result.failed++;
    } catch {
      await retry(job); result.failed++;
    } finally { stopHeartbeat(); }
  }
  return result;
}
