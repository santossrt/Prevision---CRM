import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardDTO } from "../../src/lib/dashboard/types.ts";
import { getDashboard, parseDashboard } from "../../src/components/dashboard/dashboard-api.ts";
import { chartInteger, chartPosition, dashboardDayLabel, dashboardFullDay, dashboardPreset, dashboardProductHref, dashboardQuery, dashboardToday, validDashboardDay } from "../../src/components/dashboard/dashboard-meta.ts";

const productId = "00000000-0000-4000-8000-000000000001";
const report: DashboardDTO = {
  generatedAt: "2026-11-06T12:00:00.000Z", period: { from: "2026-11-01", to: "2026-11-06", granularity: "day", timeZone: "America/Sao_Paulo" },
  current: { products: 2, activeProducts: 1, inactiveProducts: 1, lowStock: 1, emptyStock: 0, estimatedCost: "9999999999999999980000000000.01", potentialSale: "0.00", estimatedMargin: "-9999999999999999980000000000.01" },
  movements: { entries: 1, exits: 1, adjustments: 1, compensations: 0, entriesCost: "10.01", exitsCost: "1.00", exitsSale: "2.50" },
  units: [{ unit: "UN", entryQuantity: "99999999999999.9999", exitQuantity: "1.0000", adjustmentDelta: "-0.0001", compensationDelta: "0.0000" }],
  series: [{ from: "2026-11-01", to: "2026-11-01", entries: 1, exits: 1, entriesCost: "10.01", exitsCost: "1.00", exitsSale: "2.50", adjustments: 1, compensations: 0, estimatedStockCost: "99.01" }],
  mostMoved: [{ id: productId, name: "Café", sku: "CAFE", movements: 2, entries: 1, exits: 1, exitCost: "1.00" }],
  highestValue: [{ id: productId, name: "Café", sku: "CAFE", unit: "UN", isActive: true, quantity: "99999999999999.9999", estimatedCost: "9999999999999999980000000000.01", potentialSale: "0.00" }],
  categories: [{ id: productId, name: "Alimentos", products: 2, estimatedCost: "9999999999999999980000000000.01" }], warnings: ["Custos atuais são estimativas; o histórico usa os valores registrados."]
};
const copy = () => structuredClone(report);
beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("datas do dashboard no horário de Brasília", () => {
  it("o dia de Brasília pode ser anterior ao dia UTC, sem depender do fuso do navegador", () => {
    const now = new Date("2026-11-06T01:00:00Z");
    expect(dashboardToday(now)).toBe("2026-11-05");
    expect(dashboardPreset(30, now)).toEqual({ from: "2026-10-07", to: "2026-11-05" });
    expect(dashboardPreset(90, now)).toEqual({ from: "2026-08-08", to: "2026-11-05" });
  });
  it("valida dias reais e preserva datas no rótulo sem conversão de meia-noite", () => {
    expect(validDashboardDay("2024-02-29")).toBe(true);
    expect(validDashboardDay("2026-02-29")).toBe(false);
    expect(validDashboardDay("2026-11-31")).toBe(false);
    expect(dashboardDayLabel("2026-11-01")).toBe("01/11");
    expect(dashboardDayLabel("2026-11-01", true)).toBe("11/2026");
    expect(dashboardFullDay("2026-11-01")).toBe("01/11/2026");
  });
  it("envia as datas civis e permite o padrão do servidor quando ambas estão ausentes", () => {
    expect(dashboardQuery({ from: "2026-11-01", to: "2026-11-05" }, new Date("2026-11-05T12:00:00Z"))).toBe("from=2026-11-01&to=2026-11-05");
    expect(dashboardQuery({ from: "", to: "" })).toBe("");
  });
  it.each([
    { from: "", to: "2026-11-05" }, { from: "2026-02-30", to: "2026-11-05" },
    { from: "2026-11-05", to: "2026-11-04" }, { from: "2026-11-01", to: "2026-11-06" },
    { from: "2025-11-03", to: "2026-11-05" }
  ])("recusa período incompleto, impossível, invertido, futuro ou excessivo", (filter) => {
    expect(() => dashboardQuery(filter, new Date("2026-11-05T12:00:00Z"))).toThrow();
  });
  it("conta o limite de 366 dias de forma inclusiva", () => {
    expect(dashboardQuery({ from: "2025-11-05", to: "2026-11-05" }, new Date("2026-11-05T12:00:00Z"))).toBeTruthy();
    expect(() => dashboardQuery({ from: "2025-11-04", to: "2026-11-05" }, new Date("2026-11-05T12:00:00Z"))).toThrow("366");
  });
});

describe("proporções de gráficos sem perder os valores financeiros", () => {
  it("mantém a precisão de valores além do limite inteiro do JavaScript", () => {
    expect(chartInteger("9999999999999999980000000000.01")).toBe(99999999999999999800000000000100n);
    expect(chartInteger("-0.0001")).toBe(-1n);
    const max = chartInteger("9999999999999999980000000000.00");
    expect(chartPosition(max / 2n, max)).toBe(50);
  });
  it("limita somente a coordenada visual, sem dividir por zero ou produzir NaN", () => {
    expect(chartPosition(10n, 0n)).toBe(0);
    expect(chartPosition(-5n, 100n)).toBe(0);
    expect(chartPosition(150n, 100n)).toBe(100);
    expect(chartPosition(1n, 3n, 190)).toBe(63.33);
    expect(() => chartPosition(1n, 3n, Infinity)).toThrow();
    expect(() => chartInteger("NaN")).toThrow();
  });
  it("destinos de produtos aceitam somente identificadores internos", () => {
    expect(dashboardProductHref(productId)).toBe(`/estoque?productId=${productId}`);
    expect(dashboardProductHref("https://bad.invalid")).toBeNull();
  });
});

describe("contrato de indicadores recebido do servidor", () => {
  it("preserva quantidades e centavos exatos e mantém apenas o DTO público", () => {
    const source = { ...copy(), password: "PRIVATE_VALUE" };
    const parsed = parseDashboard(source);
    expect(parsed).toEqual(report);
    expect(parsed.highestValue[0].estimatedCost).toBe("9999999999999999980000000000.01");
    expect(parsed.units[0].entryQuantity).toBe("99999999999999.9999");
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE_VALUE");
  });
  it.each([Infinity, -1, 1.5, "2"])("recusa contagens inválidas: %s", (invalid) => {
    const source = copy() as unknown as { current: { products: unknown } }; source.current.products = invalid;
    expect(() => parseDashboard(source)).toThrow();
  });
  it("não aceita gráficos malformados nem datas fora da consulta", () => {
    const source = copy(); source.series[0].from = "2026-10-31";
    expect(() => parseDashboard(source)).toThrow();
    const overlap = copy(); overlap.series.push({ ...overlap.series[0] });
    expect(() => parseDashboard(overlap)).toThrow();
    const invalid = copy(); invalid.series[0].estimatedStockCost = "1e30";
    expect(() => parseDashboard(invalid)).toThrow();
  });
  it("recusa dinheiro numérico e totais de produtos incoerentes", () => {
    const numeric = copy() as unknown as { current: { estimatedCost: unknown } }; numeric.current.estimatedCost = 99.01;
    expect(() => parseDashboard(numeric)).toThrow();
    const source = copy(); source.current.activeProducts = 3;
    expect(() => parseDashboard(source)).toThrow();
    const moved = copy(); moved.mostMoved[0].movements = 9;
    expect(() => parseDashboard(moved)).toThrow();
  });
  it("permite zero real e ausência de rankings sem criar dados substitutos", () => {
    const source = copy(); source.mostMoved = []; source.highestValue = []; source.categories = []; source.units = [];
    source.current = { products: 0, activeProducts: 0, inactiveProducts: 0, lowStock: 0, emptyStock: 0, estimatedCost: "0.00", potentialSale: "0.00", estimatedMargin: "0.00" };
    expect(parseDashboard(source).current.products).toBe(0);
    expect(parseDashboard(source).highestValue).toEqual([]);
  });
  it("faz consulta autenticada sem cache e conserva a resposta exata", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(report));
    expect(await getDashboard("from=2026-11-01&to=2026-11-06")).toEqual(report);
    expect(fetch).toHaveBeenCalledWith("/api/dashboard?from=2026-11-01&to=2026-11-06", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });
  it.each([401, 403])("preserva o código de acesso %i para limpar dados sem autorização", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ message: "Acesso recusado." }, { status }));
    await expect(getDashboard("")).rejects.toMatchObject({ status, message: "Acesso recusado." });
  });
  it("propaga o cancelamento e apresenta erro de conexão seguro", async () => {
    const controller = new AbortController(); controller.abort();
    vi.mocked(fetch).mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    await expect(getDashboard("", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    vi.mocked(fetch).mockRejectedValueOnce(new Error("PRIVATE_NETWORK_DETAIL"));
    await expect(getDashboard("")).rejects.toMatchObject({ message: "A conexão foi interrompida. Tente atualizar os indicadores." });
  });
});
