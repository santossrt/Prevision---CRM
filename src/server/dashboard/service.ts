import "server-only";
import type { DashboardDTO } from "../../lib/dashboard/types.ts";
import { identityInclude, principalFromSession, type Principal } from "../auth/identity.ts";
import { assertPermission } from "../authorization/guard.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { loadDashboardData } from "./data.ts";
import { parseDashboardPeriod } from "./validation.ts";

function dashboardPermissions(actor: Principal) {
  assertPermission(actor, "reports.read"); assertPermission(actor, "stock.read");
}
export async function getDashboard(actor: Principal, search: URLSearchParams): Promise<DashboardDTO> {
  dashboardPermissions(actor);
  await verifyDatabaseIdentity();
  return getDatabase().$transaction(async (tx) => {
    // Shared locks follow the write services' order. Revalidate with READ
    // COMMITTED after waiting; never authorize from a pre-wait snapshot.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103002)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(2026103003)`;
    const session = await tx.loginSession.findUnique({ where: { id: actor.sessionId }, include: identityInclude });
    const current = session && principalFromSession(session, { sub: actor.id, version: actor.sessionVersion });
    if (!current) throw new ApplicationError("UNAUTHORIZED", "Entre novamente para continuar.");
    dashboardPermissions(current);
    const period = parseDashboardPeriod(search);
    return loadDashboardData(tx, period);
  }, { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 });
}
