import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../src/server/auth/identity.ts";
import { getDashboard } from "../../src/server/dashboard/service.ts";
import { loadDashboardData } from "../../src/server/dashboard/data.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown>, current: null as Principal | null }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));
vi.mock("../../src/server/auth/identity.ts", () => ({ identityInclude: { user: true }, principalFromSession: () => state.current }));
vi.mock("../../src/server/dashboard/data.ts", () => ({ loadDashboardData: vi.fn().mockResolvedValue({ current: { products: 1 } }) }));
const actor: Principal = { id: "00000000-0000-4000-8000-000000000001", name: "Responsável", email: "user@example.invalid", role: "OPERATOR", permissions: ["reports.read", "stock.read"], sessionId: "00000000-0000-4000-8000-000000000002", sessionVersion: 0, googleLinked: false, hasPassword: true, googleAccessAllowed: false };
function fixture() {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(0), loginSession: { findUnique: vi.fn().mockResolvedValue({ id: actor.sessionId }) } };
  const db = { $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown, _options?: unknown) => work(tx)) };
  state.database = db;
  return { tx, db };
}
beforeEach(() => { state.current = { ...actor, permissions: [...actor.permissions] }; vi.mocked(loadDashboardData).mockClear(); });
describe("acesso aos indicadores", () => {
  it.each([{ permissions: ["reports.read"] }, { permissions: ["stock.read"] }, { permissions: [] }])("exige as duas permissões antes de consultar: %j", async ({ permissions }) => {
    const { db } = fixture();
    await expect(getDashboard({ ...actor, permissions }, new URLSearchParams())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.$transaction).not.toHaveBeenCalled(); expect(loadDashboardData).not.toHaveBeenCalled();
  });
  it("sessão revogada impede indicadores mesmo com um actor antigo autorizado", async () => {
    const { tx } = fixture(); state.current = null;
    await expect(getDashboard(actor, new URLSearchParams())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.loginSession.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: actor.sessionId } }));
    expect(loadDashboardData).not.toHaveBeenCalled();
  });
  it("revalida após aguardar os locks, sem reutilizar permissões antigas", async () => {
    const { tx } = fixture();
    tx.$executeRaw.mockImplementationOnce(async () => { state.current = { ...actor, permissions: ["reports.read"] }; return 0; });
    await expect(getDashboard(actor, new URLSearchParams())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(loadDashboardData).not.toHaveBeenCalled();
  });
  it("só carrega a fonte após revalidar autorização, na ordem de locks dos escritores", async () => {
    const { tx, db } = fixture();
    await expect(getDashboard(actor, new URLSearchParams("from=2026-10-01&to=2026-10-02"))).resolves.toMatchObject({ current: { products: 1 } });
    expect(tx.$executeRaw.mock.calls.map((call) => String(call[0]))).toEqual(["SELECT pg_advisory_xact_lock_shared(2026103002)", "SELECT pg_advisory_xact_lock_shared(2026103003)"]);
    expect(db.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: "ReadCommitted" });
    expect(loadDashboardData).toHaveBeenCalledWith(tx, { from: "2026-10-01", to: "2026-10-02", granularity: "day", timeZone: "America/Sao_Paulo" });
  });
});
