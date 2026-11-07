import "server-only";
import type { AnalysisDTO } from "../../lib/analyses/types.ts";
import { identityInclude, principalFromSession, type Principal } from "../auth/identity.ts";
import { assertPermission } from "../authorization/guard.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { parseAnalysisFilters } from "./validation.ts";
import { loadAnalysisData } from "./data.ts";

function permissions(actor: Principal) { assertPermission(actor, "reports.read"); assertPermission(actor, "stock.read"); }
export async function getAnalyses(actor: Principal, search: URLSearchParams): Promise<AnalysisDTO> {
  permissions(actor);
  await verifyDatabaseIdentity();
  return getDatabase().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103002)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103003)`;
    const record = await tx.loginSession.findUnique({ where: { id: actor.sessionId }, include: identityInclude });
    const current = record && principalFromSession(record, { sub: actor.id, version: actor.sessionVersion });
    if (!current) throw new ApplicationError("UNAUTHORIZED", "Entre novamente para continuar.");
    permissions(current);
    return loadAnalysisData(tx, parseAnalysisFilters(search));
  }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 });
}
