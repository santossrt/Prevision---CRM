import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnalysisDTO } from "../../src/lib/analyses/types.ts";
import { canViewAnalyses } from "../../src/lib/analyses/access.ts";
import { analysisExportFilters, analysisFilters, analysisInteger, analysisPreset, analysisQuery, analysisDay, analysisProductHref, chartPosition, emptyAnalysisForm } from "../../src/components/analyses/analyses-meta.ts";
import { AnalysisRequestError, getAnalysis, parseAnalysis } from "../../src/components/analyses/analyses-api.ts";

const now = new Date("2026-11-07T01:00:00Z");
const productId = "00000000-0000-4000-8000-000000000001";
function fixture(): AnalysisDTO {
  return {
    generatedAt: "2026-11-06T20:00:00.000Z", asOfDate: "2026-11-06", filters: { from: "2026-08-09", to: "2026-11-06", search: "", status: "all", thresholdA: "80.00", thresholdB: "95.00", horizonDays: 30 },
    criteria: { timeZone: "America/Sao_Paulo", periodDays: 90, minimumHistoryDays: 30, minimumPositiveExitDays: 2, dateLimitDays: 3650 },
    abc: { totalConsumptionCost: "80.00", products: [{ id: productId, name: "Produto", sku: "A01", unit: "UN", isActive: true, unitChanged: false, grossExitQuantity: "10.0000", reversedExitQuantity: "0.0000", netQuantity: "10.0000", grossExitCost: "80.00", reversedExitCost: "0.00", consumptionCost: "80.00", clamped: false, share: "100.00", cumulativeShare: "100.00", classification: "A" }], classes: [{ classification: "A", products: 1, consumptionCost: "80.00", share: "100.00" }, ...(["B", "C", null] as const).map((classification) => ({ classification, products: 0, consumptionCost: "0.00", share: "0.00" }))] },
    replenishment: { reorderCount: 0, insufficientCount: 0, products: [{ id: productId, name: "Produto", sku: "A01", unit: "UN", isActive: true, quantity: "10.0000", minimumStock: "0.0000", safetyStock: "0.0000", minimumGap: "0.0000", supplier: null, leadTimeDays: 0, leadTimeSource: "product", observedDays: 90, positiveExitDays: 2, netExitQuantity: "10.0000", averageDaily: "0.11111111", daysUntilStockout: "90.00", reorderPoint: "0.0000", recommendedQuantity: "0.0000", estimatedStockoutDate: "2027-02-04", estimatedReorderDate: "2027-02-04", dateLimited: false, status: "OK" }] }, warnings: ["Estimativa pelos dados observados."]
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("filtros e apresentação das análises", () => {
  it("usa dias civis de São Paulo para o padrão e preserva rótulos de calendário", () => {
    expect(analysisPreset(now)).toMatchObject({ from: "2026-08-09", to: "2026-11-06" });
    expect(analysisDay("2026-11-06")).toBe("06/11/2026");
  });
  it("normaliza limites sem arredondar percentuais e compartilha filtros exatos com a exportação", () => {
    const filters = analysisFilters({ ...analysisPreset(now), thresholdA: "75,5", thresholdB: "90", search: "  Café  ", horizonDays: "45" }, now);
    expect(filters).toMatchObject({ thresholdA: "75.50", thresholdB: "90.00", search: "Café", horizonDays: 45 });
    expect(Object.fromEntries(new URLSearchParams(analysisQuery(filters)))).toEqual(analysisExportFilters(filters));
  });
  it.each([{ thresholdA: "0" }, { thresholdA: "95", thresholdB: "80" }, { thresholdB: "100" }, { thresholdA: "80.001" }, { thresholdA: "NaN" }, { horizonDays: "0" }, { horizonDays: "366" }, { horizonDays: "1e2" }, { from: "2026-02-30" }, { from: "2025-01-01" }, { to: "2026-11-07" }, { status: "other" }, { search: "\u0000" }])("recusa critérios inválidos %j", (changes) => expect(() => analysisFilters({ ...analysisPreset(now), ...changes }, now)).toThrow());
  it("exige ambas permissões e restringe os links ao produto conhecido", () => {
    expect(canViewAnalyses(["reports.read"])).toBe(false); expect(canViewAnalyses(["stock.read"])).toBe(false); expect(canViewAnalyses(["reports.read", "stock.read"])).toBe(true);
    expect(analysisProductHref(productId)).toBe(`/estoque?productId=${productId}`); expect(analysisProductHref("https://bad.invalid")).toBe(null);
  });
  it("converte valores grandes somente para proporções limitadas do desenho", () => {
    expect(analysisInteger("9999999999999999980000000049.37")).toBe(999999999999999998000000004937n);
    expect(chartPosition(1n, 3n)).toBe(33.33); expect(chartPosition(0n, 0n)).toBe(0); expect(chartPosition(2n, 1n)).toBe(100);
    expect(() => analysisInteger("1.234")).toThrow(); expect(() => analysisInteger("Infinity")).toThrow();
  });
});
describe("contrato da análise recebida", () => {
  it("preserva prazo zero, casas da média e quantidades grandes", () => {
    const input = fixture(); input.replenishment.products[0].quantity = "99999999999999.9999";
    const result = parseAnalysis(input);
    expect(result.replenishment.products[0].leadTimeDays).toBe(0); expect(result.replenishment.products[0].quantity).toBe("99999999999999.9999"); expect(result.replenishment.products[0].averageDaily).toBe("0.11111111");
  });
  it("aceita análise vazia e consumo zero sem inventar classificação", () => {
    const input = fixture(); input.abc.totalConsumptionCost = "0.00"; input.abc.products = []; input.abc.classes.forEach((entry) => { entry.products = 0; entry.consumptionCost = "0.00"; entry.share = "0.00"; }); input.replenishment.products = [];
    expect(parseAnalysis(input).abc.products).toEqual([]);
    const zero = fixture(); Object.assign(zero.abc.products[0], { consumptionCost: "0.00", share: "0.00", cumulativeShare: "0.00", classification: null }); expect(parseAnalysis(zero).abc.products[0].classification).toBe(null);
  });
  it("aceita ausência de estimativa com seu motivo e rejeita uma recomendação contraditória", () => {
    const input = fixture(); Object.assign(input.replenishment.products[0], { status: "INSUFFICIENT_HISTORY", averageDaily: null, daysUntilStockout: null, reorderPoint: null, recommendedQuantity: null, estimatedStockoutDate: null, estimatedReorderDate: null });
    expect(parseAnalysis(input).replenishment.products[0].averageDaily).toBe(null);
    input.replenishment.products[0].recommendedQuantity = "1.0000"; expect(() => parseAnalysis(input)).toThrow();
  });
  it("não converte troca de unidade em quantidade comparável", () => {
    const input = fixture(); Object.assign(input.abc.products[0], { unitChanged: true, netQuantity: null }); expect(parseAnalysis(input).abc.products[0].netQuantity).toBe(null);
    input.abc.products[0].netQuantity = "10.0000"; expect(() => parseAnalysis(input)).toThrow();
  });
  it.each(["number-money", "bad-class", "duplicate-id", "percent", "bad-date"])("recusa resposta incoerente: %s", (kind) => {
    const input = fixture();
    if (kind === "number-money") (input.abc as unknown as Record<string, unknown>).totalConsumptionCost = 80;
    if (kind === "bad-class") (input.abc.products[0] as unknown as Record<string, unknown>).classification = "D";
    if (kind === "duplicate-id") { input.abc.products.push(input.abc.products[0]); input.replenishment.products.push(input.replenishment.products[0]); }
    if (kind === "percent") input.abc.products[0].share = "100.01";
    if (kind === "bad-date") input.filters.to = "2026-02-30";
    expect(() => parseAnalysis(input)).toThrow(AnalysisRequestError);
  });
  it("consulta sem cache e preserva o código de acesso recusado para limpar a tela", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Sem permissão" }), { status: 403 })); vi.stubGlobal("fetch", fetcher);
    await expect(getAnalysis("from=2026-08-09&to=2026-11-06")).rejects.toMatchObject({ status: 403 });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "same-origin" });
  });
  it("repassa cancelamento sem transformá-lo em uma nova consulta", async () => {
    const controller = new AbortController(); controller.abort(); const cause = new DOMException("cancelled", "AbortError"); vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause));
    await expect(getAnalysis("", controller.signal)).rejects.toBe(cause);
  });
});
