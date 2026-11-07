import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../src/generated/prisma/client.ts";
import type { AnalysisFilters } from "../../src/lib/analyses/types.ts";
import type { AnalysisProductSource } from "../../src/server/analyses/calculations.ts";
import { loadAnalysisData } from "../../src/server/analyses/data.ts";

const filters: AnalysisFilters = { from: "2026-08-01", to: "2026-10-29", search: "", status: "all", thresholdA: "80.00", thresholdB: "95.00", horizonDays: 30 };
const row: AnalysisProductSource = { id: "product", name: "Produto", sku: "001", unit: "UN", isActive: true, unitChanged: false, quantity: "50.0000", minimumStock: "30.0000", safetyStock: "10.0000", invalidBalance: false,
  supplier: { id: "supplier", name: "Fornecedor", isActive: false }, leadTimeDays: 0, leadTimeSource: "supplier", observedDays: 90, positiveExitDays: 2,
  grossExitQuantity: "180.0000", reversedExitQuantity: "0.0000", grossExitCost: "999999999999999999.99", reversedExitCost: "0.00", forecastExitQuantity: "180.0000", forecastReversedExitQuantity: "0.0000" };
function fixture(products: AnalysisProductSource[] = [row]) {
  const query = vi.fn().mockResolvedValue([{ generatedAt: "2026-11-06T12:00:00.000001Z", asOfDate: "2026-11-06", products }]);
  return { tx: { $queryRaw: query } as unknown as Prisma.TransactionClient, query };
}
describe("fonte das análises", () => {
  it("preserva números exatos e a origem do prazo, sem expor campos internos de integridade", async () => {
    const { tx, query } = fixture();
    const data = await loadAnalysisData(tx, filters);
    expect(query).toHaveBeenCalledTimes(1);
    expect(data.abc.totalConsumptionCost).toBe("999999999999999999.99");
    expect(data.replenishment.products[0]).toMatchObject({ leadTimeDays: 0, leadTimeSource: "supplier", supplier: { id: "supplier", name: "Fornecedor", isActive: false } });
    expect(JSON.stringify(data)).not.toContain("invalidBalance");
  });
  it("conjunto vazio informa zero e ausência de previsões, sem inventar uma classe", async () => {
    const { tx } = fixture([]); const data = await loadAnalysisData(tx, filters);
    expect(data.abc.products).toEqual([]); expect(data.abc.totalConsumptionCost).toBe("0.00");
    expect(data.replenishment).toEqual({ products: [], reorderCount: 0, insufficientCount: 0 });
  });
  it("nunca transforma uma amostra limitada em classificação completa", async () => {
    const { tx } = fixture(Array.from({ length: 1001 }, () => row));
    await expect(loadAnalysisData(tx, filters)).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("não usa falha da consulta ou falta de saldo como consumo zero", async () => {
    const { tx, query } = fixture(); query.mockResolvedValueOnce([]);
    await expect(loadAnalysisData(tx, filters)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const broken = fixture([{ ...row, invalidBalance: true }]);
    await expect(loadAnalysisData(broken.tx, filters)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("pesquisa escapa curingas e mantém conteúdo parametrizado", async () => {
    const { tx, query } = fixture(); const search = "%_!'; DROP TABLE products;--";
    await loadAnalysisData(tx, { ...filters, search });
    const [template, ...parameters] = query.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(template.join("")).not.toContain(search);
    const conditions = parameters.find((value) => value && typeof value === "object" && "values" in value) as Prisma.Sql;
    expect(conditions.sql).not.toContain(search);
    expect(conditions.values).toContain("%!%!_!!'; DROP TABLE products;--%");
  });
});
