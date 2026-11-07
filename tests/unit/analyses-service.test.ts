import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../src/server/auth/identity.ts";
import { getAnalyses } from "../../src/server/analyses/service.ts";
import { loadAnalysisData } from "../../src/server/analyses/data.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown>, current: null as Principal | null }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));
vi.mock("../../src/server/auth/identity.ts", () => ({ identityInclude: { user: true }, principalFromSession: () => state.current }));
vi.mock("../../src/server/analyses/data.ts", () => ({ loadAnalysisData: vi.fn().mockResolvedValue({ abc: { totalConsumptionCost: "0.00" } }) }));
const actor: Principal = { id: "00000000-0000-4000-8000-000000000001", name: "Responsável", email: "user@example.invalid", role: "OPERATOR", permissions: ["reports.read", "stock.read"], sessionId: "00000000-0000-4000-8000-000000000002", sessionVersion: 0, googleLinked: false, hasPassword: true, googleAccessAllowed: false };
function fixture() {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(0), loginSession: { findUnique: vi.fn().mockResolvedValue({ id: actor.sessionId }) } };
  const db = { $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown, _options?: unknown) => work(tx)) };
  state.database = db;
  return { tx, db };
}
beforeEach(() => { state.current = { ...actor, permissions: [...actor.permissions] }; vi.mocked(loadAnalysisData).mockClear(); });
describe("autorização das análises", () => {
  it.each([["reports.read"], ["stock.read"], []])("exige ambas as permissões: %j", async (...permissions) => {
    const { db } = fixture();
    await expect(getAnalyses({ ...actor, permissions }, new URLSearchParams())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(db.$transaction).not.toHaveBeenCalled(); expect(loadAnalysisData).not.toHaveBeenCalled();
  });
  it("recusa sessão revogada mesmo com um principal antigo", async () => {
    fixture(); state.current = null;
    await expect(getAnalyses(actor, new URLSearchParams())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(loadAnalysisData).not.toHaveBeenCalled();
  });
  it("revalida permissão após esperar pelos locks dos escritores", async () => {
    const { tx } = fixture();
    tx.$executeRaw.mockImplementationOnce(async () => { state.current = { ...actor, permissions: ["reports.read"] }; return 0; });
    await expect(getAnalyses(actor, new URLSearchParams())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(loadAnalysisData).not.toHaveBeenCalled();
  });
  it("preserva a ordem autorização/catálogo e carrega critérios normalizados", async () => {
    const { tx, db } = fixture();
    await expect(getAnalyses(actor, new URLSearchParams("from=2026-10-01&to=2026-10-31&thresholdA=70&thresholdB=90&horizonDays=15"))).resolves.toMatchObject({ abc: { totalConsumptionCost: "0.00" } });
    expect(tx.$executeRaw.mock.calls.map((call) => String(call[0]))).toEqual(["SELECT pg_advisory_xact_lock_shared(2026103002)", "SELECT pg_advisory_xact_lock_shared(2026103003)"]);
    expect(db.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: "ReadCommitted" });
    expect(loadAnalysisData).toHaveBeenCalledWith(tx, { from: "2026-10-01", to: "2026-10-31", thresholdA: "70.00", thresholdB: "90.00", horizonDays: 15, status: "all", search: "" });
  });
  it("critérios inválidos não chegam à consulta de dados", async () => {
    fixture();
    await expect(getAnalyses(actor, new URLSearchParams("thresholdA=99&thresholdB=10"))).rejects.toMatchObject({ code: "VALIDATION" });
    expect(loadAnalysisData).not.toHaveBeenCalled();
  });
});
