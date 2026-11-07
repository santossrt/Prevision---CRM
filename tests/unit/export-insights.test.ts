import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../src/generated/prisma/client.ts";
import type { AnalysisDTO } from "../../src/lib/analyses/types.ts";
import type { DashboardDTO } from "../../src/lib/dashboard/types.ts";
import { parseReportPreview, sourcePermission } from "../../src/server/transfers/export-validation.ts";
import { loadInsightReport } from "../../src/server/transfers/export-insights.ts";
import { loadAnalysisData } from "../../src/server/analyses/data.ts";
import { loadDashboardData } from "../../src/server/dashboard/data.ts";

vi.mock("../../src/server/analyses/data.ts", () => ({ loadAnalysisData: vi.fn() }));
vi.mock("../../src/server/dashboard/data.ts", () => ({ loadDashboardData: vi.fn() }));
const tx = {} as Prisma.TransactionClient;
const filters = { from: "2026-10-01", to: "2026-10-30", search: "", status: "all" as const, thresholdA: "80.00", thresholdB: "95.00", horizonDays: 30 };
function analysis(): AnalysisDTO {
  return { generatedAt: "2026-11-06T12:00:00.000Z", asOfDate: "2026-11-06", filters,
    criteria: { timeZone: "America/Sao_Paulo", periodDays: 30, minimumHistoryDays: 30, minimumPositiveExitDays: 2, dateLimitDays: 3650 },
    abc: { totalConsumptionCost: "12.34", classes: [], products: [{ id: "id", name: "Produto", sku: "00001234", unit: "UN", isActive: true, unitChanged: true, grossExitQuantity: "2.0000", reversedExitQuantity: "0.0000", netQuantity: null, grossExitCost: "12.34", reversedExitCost: "0.00", consumptionCost: "12.34", share: "100.00", cumulativeShare: "100.00", classification: "A", clamped: false }] },
    replenishment: { reorderCount: 0, insufficientCount: 1, products: [{ id: "id", name: "Produto", sku: "00001234", unit: "UN", isActive: true, quantity: "99999999999999.9999", minimumStock: "3.0000", safetyStock: "1.0000", minimumGap: "0.0000", supplier: null, leadTimeDays: null, leadTimeSource: null, observedDays: 10, positiveExitDays: 1, netExitQuantity: "2.0000", averageDaily: null, daysUntilStockout: null, reorderPoint: null, recommendedQuantity: null, estimatedStockoutDate: null, estimatedReorderDate: null, dateLimited: false, status: "INSUFFICIENT_HISTORY" }] }, warnings: ["Estimativa, não garantia."] };
}
beforeEach(() => { vi.mocked(loadAnalysisData).mockReset().mockResolvedValue(analysis()); vi.mocked(loadDashboardData).mockReset(); });
describe("relatórios de indicadores e análises", () => {
  it("normaliza os critérios no mesmo contrato da análise", () => {
    const parsed = parseReportPreview({ kind: "abc", filters: { from: filters.from, to: filters.to, thresholdA: "70", thresholdB: "90.5", horizonDays: "15" } });
    expect(parsed.filters).toMatchObject({ from: filters.from, to: filters.to, thresholdA: "70.00", thresholdB: "90.50", horizonDays: "15", status: "all" });
    expect(sourcePermission("abc")).toBe("stock.read"); expect(sourcePermission("replenishment")).toBe("stock.read"); expect(sourcePermission("indicators")).toBe("stock.read");
    for (const kind of ["abc", "replenishment", "indicators"]) expect(() => parseReportPreview({ kind, filters: { actorId: "private" } })).toThrow();
  });
  it("ABC preserva valores exatos, código, classe e advertência de unidade", async () => {
    const result = await loadInsightReport(tx, "abc", { from: filters.from, to: filters.to });
    expect(result.rows[0]).toMatchObject({ sku: "00001234", cost: "12.34", share: "100.00", classification: "A", netQuantity: null });
    expect(result.rows[0].note).toContain("Unidade alterada"); expect(result.warnings.join(" ")).toContain("80.00%");
    expect(result.warnings.join(" ")).toContain("2026-11-06");
  });
  it("ausência de histórico não vira recomendação zero ou data inventada", async () => {
    const result = await loadInsightReport(tx, "replenishment", { from: filters.from, to: filters.to });
    expect(result.rows[0]).toMatchObject({ quantity: "99999999999999.9999", status: "Histórico insuficiente", average: null, recommended: null, leadDays: null, stockoutDate: null, reorderDate: null });
    const data = analysis(); data.replenishment.products[0].leadTimeDays = 0; data.replenishment.products[0].leadTimeSource = "product";
    vi.mocked(loadAnalysisData).mockResolvedValueOnce(data);
    expect((await loadInsightReport(tx, "replenishment", {})).rows[0].leadDays).toBe("0");
  });
  it("indicadores reutilizam a fonte do dashboard e mantêm unidades distintas", async () => {
    const data: DashboardDTO = { generatedAt: "2026-11-06T12:00:00.000Z", period: { from: filters.from, to: filters.to, granularity: "day", timeZone: "America/Sao_Paulo" },
      current: { products: 2, activeProducts: 2, inactiveProducts: 0, lowStock: 1, emptyStock: 0, estimatedCost: "12.34", potentialSale: "20.00", estimatedMargin: "7.66" },
      movements: { entries: 2, exits: 0, adjustments: 0, compensations: 0, entriesCost: "12.34", exitsCost: "0.00", exitsSale: "0.00" },
      units: [{ unit: "KG", entryQuantity: "1.2500", exitQuantity: "0.0000", adjustmentDelta: "0.0000", compensationDelta: "0.0000" }, { unit: "UN", entryQuantity: "3.0000", exitQuantity: "0.0000", adjustmentDelta: "0.0000", compensationDelta: "0.0000" }], series: [], mostMoved: [], highestValue: [], categories: [], warnings: [] };
    vi.mocked(loadDashboardData).mockResolvedValueOnce(data);
    const result = await loadInsightReport(tx, "indicators", { from: filters.from, to: filters.to });
    expect(result.rows).toEqual(expect.arrayContaining([expect.objectContaining({ section: "Quantidades por unidade", metric: "Entradas brutas", value: "1.2500", unit: "KG" }), expect.objectContaining({ metric: "Custo estimado", value: "12.34", unit: "R$" })]));
    expect(loadAnalysisData).not.toHaveBeenCalled();
  });
});
