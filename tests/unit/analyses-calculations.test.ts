import { describe, expect, it } from "vitest";
import type { AnalysisFilters } from "../../src/lib/analyses/types.ts";
import { analysisScaled, buildAnalysis, replenishmentProduct, type AnalysisProductSource } from "../../src/server/analyses/calculations.ts";

const filters: AnalysisFilters = { from: "2026-08-01", to: "2026-10-29", search: "", status: "all", thresholdA: "80.00", thresholdB: "95.00", horizonDays: 30 };
function product(overrides: Partial<AnalysisProductSource> = {}): AnalysisProductSource {
  return { id: "product", name: "Produto", sku: "001", unit: "UN", isActive: true, unitChanged: false, quantity: "50.0000", minimumStock: "30.0000", safetyStock: "10.0000", invalidBalance: false,
    supplier: null, leadTimeDays: 5, leadTimeSource: "product", observedDays: 90, positiveExitDays: 2,
    grossExitQuantity: "180.0000", reversedExitQuantity: "0.0000", grossExitCost: "100.00", reversedExitCost: "0.00", forecastExitQuantity: "180.0000", forecastReversedExitQuantity: "0.0000", ...overrides };
}
const run = (rows: AnalysisProductSource[], criteria = filters) => buildAnalysis(rows, criteria, "2026-11-06T12:00:00Z", "2026-11-06");
describe("Curva ABC pelo consumo histórico líquido", () => {
  it("classifica limites exatos usando o acumulado anterior, sem tratar o item dominante como C", () => {
    const data = run([product({ id: "c", grossExitCost: "5.00" }), product({ id: "a", grossExitCost: "80.00" }), product({ id: "b", grossExitCost: "15.00" })]);
    expect(data.abc.products.map((item) => [item.id, item.classification, item.share, item.cumulativeShare])).toEqual([["a", "A", "80.00", "80.00"], ["b", "B", "15.00", "95.00"], ["c", "C", "5.00", "100.00"]]);
    expect(run([product({ grossExitCost: "100.00" })]).abc.products[0].classification).toBe("A");
  });
  it("preserva a classe ao cruzar um limite e agrupa empates financeiros", () => {
    expect(run([product({ id: "a", grossExitCost: "70.00" }), product({ id: "b", grossExitCost: "20.00" }), product({ id: "c", grossExitCost: "10.00" })]).abc.products.map((row) => row.classification)).toEqual(["A", "A", "B"]);
    expect(run([product({ id: "a", grossExitCost: "80.00" }), product({ id: "b", grossExitCost: "10.00" }), product({ id: "c", grossExitCost: "10.00" })]).abc.products.map((row) => row.classification)).toEqual(["A", "B", "B"]);
  });
  it("configura as faixas e calcula participação sem precisão binária", () => {
    const data = run([product({ id: "a", grossExitCost: "50.00" }), product({ id: "b", grossExitCost: "40.00" }), product({ id: "c", grossExitCost: "10.00" })], { ...filters, thresholdA: "50.00", thresholdB: "90.00" });
    expect(data.abc.products.map((row) => row.classification)).toEqual(["A", "B", "C"]);
    const thirds = run([product({ id: "a", grossExitCost: "0.01" }), product({ id: "b", grossExitCost: "0.01" }), product({ id: "c", grossExitCost: "0.01" })]);
    expect(thirds.abc.products.map((row) => row.cumulativeShare)).toEqual(["33.33", "66.67", "100.00"]);
    expect(thirds.abc.products.every((row) => row.classification === "A")).toBe(true);
  });
  it("limita reversões negativas a zero e deixa custo zero sem classe financeira", () => {
    const data = run([product({ id: "negative", grossExitQuantity: "1.0000", reversedExitQuantity: "2.0000", grossExitCost: "1.00", reversedExitCost: "2.00" }), product({ id: "zero", grossExitCost: "0.00" })]);
    expect(data.abc.totalConsumptionCost).toBe("0.00");
    expect(data.abc.products.find((row) => row.id === "negative")).toMatchObject({ netQuantity: "0.0000", consumptionCost: "0.00", classification: null, clamped: true, share: "0.00" });
    expect(data.abc.classes.find((row) => row.classification === null)?.products).toBe(2);
  });
  it("preserva custo financeiro quando a unidade mudou, sem somar quantidades incompatíveis", () => {
    const row = run([product({ unitChanged: true })]).abc.products[0];
    expect(row).toMatchObject({ consumptionCost: "100.00", classification: "A", netQuantity: null, unitChanged: true });
  });
  it("não arredonda somas grandes nem classifica uma amostra parcial", () => {
    const huge = "9999999999999999999999999.99";
    expect(run([product({ grossExitCost: huge }), product({ id: "second", grossExitCost: "0.01" })]).abc.totalConsumptionCost).toBe("10000000000000000000000000.00");
    expect(() => run(Array.from({ length: 1001 }, () => product()))).toThrow("1.000 produtos");
  });
});

describe("estimativa racional de reposição", () => {
  it("calcula consumo, cobertura, ponto, quantidade e datas a partir do saldo atual", () => {
    const row = replenishmentProduct(product(), filters, "2026-11-06");
    expect(row).toMatchObject({ averageDaily: "2.00000000", daysUntilStockout: "25.00", reorderPoint: "30.0000", recommendedQuantity: "30.0000", estimatedStockoutDate: "2026-12-01", estimatedReorderDate: "2026-11-16", status: "OK", minimumGap: "0.0000" });
    expect(replenishmentProduct(product({ quantity: "0.0000" }), filters, "2026-11-06")).toMatchObject({ status: "REORDER", minimumGap: "30.0000", estimatedStockoutDate: "2026-11-06", estimatedReorderDate: "2026-11-06", recommendedQuantity: "80.0000" });
  });
  it("aceita prazo zero e mantém cobertura sem inventar prazo ausente", () => {
    expect(replenishmentProduct(product({ leadTimeDays: 0, minimumStock: "0.0000", safetyStock: "0.0000" }), filters, "2026-11-06")).toMatchObject({ reorderPoint: "0.0000", recommendedQuantity: "10.0000", leadTimeDays: 0 });
    expect(replenishmentProduct(product({ leadTimeDays: null, leadTimeSource: null }), filters, "2026-11-06")).toMatchObject({ status: "MISSING_LEAD_TIME", averageDaily: "2.00000000", daysUntilStockout: "25.00", estimatedStockoutDate: "2026-12-01", recommendedQuantity: null, estimatedReorderDate: null });
  });
  it.each([
    [{ observedDays: 29 }, "INSUFFICIENT_HISTORY"], [{ positiveExitDays: 1 }, "INSUFFICIENT_HISTORY"],
    [{ forecastExitQuantity: "0.0000", positiveExitDays: 0 }, "NO_CONSUMPTION"], [{ observedDays: 0, positiveExitDays: 0 }, "INSUFFICIENT_HISTORY"],
    [{ isActive: false }, "INACTIVE"], [{ unitChanged: true }, "UNIT_CHANGED"]
  ] as const)("explica a ausência de estimativa: %j", (overrides, status) => {
    expect(replenishmentProduct(product(overrides), filters, "2026-11-06")).toMatchObject({ status, averageDaily: null, recommendedQuantity: null, estimatedStockoutDate: null });
  });
  it("arredonda compra para cima sem usar a média já arredondada da tela", () => {
    const row = replenishmentProduct(product({ quantity: "0.0000", minimumStock: "0.0000", safetyStock: "0.0000", leadTimeDays: 0, observedDays: 30, forecastExitQuantity: "0.0003", forecastReversedExitQuantity: "0.0002" }), { ...filters, horizonDays: 1 }, "2026-11-06");
    expect(row.averageDaily).toBe("0.00000333"); expect(row.recommendedQuantity).toBe("0.0001");
  });
  it("mantém cobertura enorme sem datas inválidas ou Infinity", () => {
    const row = replenishmentProduct(product({ quantity: "99999999999999.9999", forecastExitQuantity: "0.0003", forecastReversedExitQuantity: "0.0002" }), filters, "2026-11-06");
    expect(row.daysUntilStockout).toBe("89999999999999999910.00");
    expect(row).toMatchObject({ dateLimited: true, estimatedStockoutDate: null, estimatedReorderDate: null, recommendedQuantity: "0.0000" });
  });
  it("não transforma saldo ausente, divergente ou NUMERIC inválido em previsão", () => {
    for (const row of [product({ quantity: null }), product({ invalidBalance: true }), product({ quantity: "NaN" }), product({ leadTimeDays: -1 })]) expect(() => replenishmentProduct(row, filters, "2026-11-06")).toThrow();
    expect(() => analysisScaled("1.00001", 4)).toThrow();
  });
});
