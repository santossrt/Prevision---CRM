import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../src/generated/prisma/client.ts";
import type { DashboardPeriod } from "../../src/lib/dashboard/types.ts";
import { dashboardFixed, loadDashboardData } from "../../src/server/dashboard/data.ts";

const period: DashboardPeriod = { from: "2026-10-01", to: "2026-10-02", granularity: "day", timeZone: "America/Sao_Paulo" };
function result() {
  return {
    generatedAt: "2026-11-06T12:00:00.000000Z",
    current: { products: 2, activeProducts: 1, inactiveProducts: 1, lowStock: 1, emptyStock: 0, estimatedCost: "9999999999999999980000000000.00", potentialSale: "2", estimatedMargin: "-9999999999999999979999999998.00" },
    movements: { entries: 1, exits: 1, adjustments: 1, compensations: 1, entriesCost: "0.01", exitsCost: "1", exitsSale: "0" },
    units: [{ unit: "KG", entryQuantity: "99999999999999.9999", exitQuantity: "0.0001", adjustmentDelta: "-1", compensationDelta: "0" }],
    series: [{ from: "2026-10-01", to: "2026-10-01", entries: 1, exits: 1, adjustments: 0, compensations: 0, entriesCost: "0.01", exitsCost: "1", exitsSale: "0", estimatedStockCost: "10.00" }],
    mostMoved: [{ id: "product", name: "Produto", sku: "0001", movements: 2, entries: 1, exits: 1, exitCost: "1" }],
    highestValue: [{ id: "product", name: "Produto", sku: "0001", unit: "KG", isActive: false, quantity: "0.2500", estimatedCost: "10", potentialSale: "2" }],
    categories: [{ id: "other", name: "Outras categorias", products: 2, estimatedCost: "10" }],
    integrity: { invalidBalances: 0, invalidCosts: 0, missingHistoricalCosts: 0, negativeHistoricalBalances: 0, ambiguousHistoricalCosts: 0 }
  };
}
describe("precisão e integridade dos indicadores", () => {
  it.each([
    ["0", 2, "0.00"], ["-0.0000", 2, "0.00"], ["0001.2300", 2, "1.23"],
    ["-2", 4, "-2.0000"], ["9999999999999999980000000000.00", 2, "9999999999999999980000000000.00"]
  ])("formata NUMERIC %s sem passar por ponto flutuante", (input, places, expected) => {
    expect(dashboardFixed(String(input), Number(places))).toBe(expected);
  });
  it.each(["NaN", "Infinity", "1e5", "1.234", "1,20"])("recusa perda de precisão ou formato interno inesperado: %s", (value) => {
    expect(() => dashboardFixed(value, 2)).toThrow();
  });
  it("preserva somas acima de Number.MAX_SAFE_INTEGER e quantidades por unidade", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([result()]) } as unknown as Prisma.TransactionClient;
    const data = await loadDashboardData(tx, period);
    expect(data.current.estimatedCost).toBe("9999999999999999980000000000.00");
    expect(data.current.estimatedMargin).toBe("-9999999999999999979999999998.00");
    expect(data.movements).toMatchObject({ entriesCost: "0.01", exitsCost: "1.00", exitsSale: "0.00", compensations: 1 });
    expect(data.units).toEqual([{ unit: "KG", entryQuantity: "99999999999999.9999", exitQuantity: "0.0001", adjustmentDelta: "-1.0000", compensationDelta: "0.0000" }]);
    expect(data.highestValue[0]).toMatchObject({ isActive: false, quantity: "0.2500", estimatedCost: "10.00" });
    expect(data.mostMoved[0].exitCost).toBe("1.00");
    expect(data.categories[0].estimatedCost).toBe("10.00");
    expect(data).not.toHaveProperty("integrity");
    expect(data.warnings.join(" ")).toContain("brutos");
    expect(data.warnings.join(" ")).toContain("reconstrução");
  });
  it.each(["invalidBalances", "invalidCosts", "missingHistoricalCosts", "negativeHistoricalBalances", "ambiguousHistoricalCosts"] as const)("não apresenta valores inventados com %s", async (field) => {
    const row = result(); row.integrity[field] = 1;
    const tx = { $queryRaw: vi.fn().mockResolvedValue([row]) } as unknown as Prisma.TransactionClient;
    await expect(loadDashboardData(tx, period)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("não transforma ausência de resposta em indicadores de estoque zero", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) } as unknown as Prisma.TransactionClient;
    await expect(loadDashboardData(tx, period)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
