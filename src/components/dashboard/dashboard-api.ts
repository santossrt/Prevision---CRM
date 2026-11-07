"use client";
import type { DashboardDTO, DashboardMovedProduct, DashboardProduct, DashboardSeriesPoint } from "../../lib/dashboard/types.ts";
import { validDashboardDay } from "./dashboard-meta.ts";

export class DashboardRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, maximum = 1000): value is string => typeof value === "string" && value.length <= maximum;
const money = (value: unknown): value is string => typeof value === "string" && /^\d{1,100}\.\d{2}$/u.test(value);
const signedMoney = (value: unknown): value is string => typeof value === "string" && /^-?\d{1,100}\.\d{2}$/u.test(value);
const quantity = (value: unknown): value is string => typeof value === "string" && /^\d{1,100}\.\d{4}$/u.test(value);
const signedQuantity = (value: unknown): value is string => typeof value === "string" && /^-?\d{1,100}\.\d{4}$/u.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
const instant = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(new Date(value).getTime());
const invalid = () => new DashboardRequestError("Não foi possível conferir os indicadores recebidos. Atualize a consulta.", 0);

function product(value: unknown): DashboardProduct {
  if (!object(value) || !uuid(value.id) || !text(value.name) || !text(value.sku, 64) || !text(value.unit, 20) || typeof value.isActive !== "boolean"
    || !quantity(value.quantity) || !money(value.estimatedCost) || !money(value.potentialSale)) throw invalid();
  return { id: value.id, name: value.name, sku: value.sku, unit: value.unit, isActive: value.isActive, quantity: value.quantity, estimatedCost: value.estimatedCost, potentialSale: value.potentialSale };
}
function moved(value: unknown): DashboardMovedProduct {
  if (!object(value) || !uuid(value.id) || !text(value.name) || !text(value.sku, 64) || !count(value.movements) || !count(value.entries) || !count(value.exits)
    || value.movements !== value.entries + value.exits || !money(value.exitCost)) throw invalid();
  return { id: value.id, name: value.name, sku: value.sku, movements: value.movements, entries: value.entries, exits: value.exits, exitCost: value.exitCost };
}
function point(value: unknown): DashboardSeriesPoint {
  if (!object(value) || !validDashboardDay(value.from) || !validDashboardDay(value.to) || value.from > value.to
    || !count(value.entries) || !count(value.exits) || !count(value.adjustments) || !count(value.compensations)
    || !money(value.entriesCost) || !money(value.exitsCost) || !money(value.exitsSale) || !signedMoney(value.estimatedStockCost)) throw invalid();
  return { from: value.from, to: value.to, entries: value.entries, exits: value.exits, entriesCost: value.entriesCost, exitsCost: value.exitsCost, exitsSale: value.exitsSale, adjustments: value.adjustments, compensations: value.compensations, estimatedStockCost: value.estimatedStockCost };
}

export function parseDashboard(value: unknown): DashboardDTO {
  if (!object(value) || !instant(value.generatedAt) || !object(value.period) || !validDashboardDay(value.period.from) || !validDashboardDay(value.period.to)
    || value.period.from > value.period.to || !["day", "month"].includes(String(value.period.granularity)) || value.period.timeZone !== "America/Sao_Paulo"
    || !object(value.current) || !object(value.movements) || !Array.isArray(value.units) || value.units.length > 1000
    || !Array.isArray(value.series) || value.series.length > 366 || !Array.isArray(value.mostMoved) || value.mostMoved.length > 10
    || !Array.isArray(value.highestValue) || value.highestValue.length > 10 || !Array.isArray(value.categories) || value.categories.length > 1000
    || !Array.isArray(value.warnings) || value.warnings.length > 30 || !value.warnings.every((warning) => text(warning, 2000))) throw invalid();
  const current = value.current; const movements = value.movements; const period = value.period;
  if (![current.products, current.activeProducts, current.inactiveProducts, current.lowStock, current.emptyStock].every(count)
    || current.products !== (current.activeProducts as number) + (current.inactiveProducts as number)
    || (current.lowStock as number) + (current.emptyStock as number) > (current.activeProducts as number)
    || !money(current.estimatedCost) || !money(current.potentialSale) || !signedMoney(current.estimatedMargin)
    || ![movements.entries, movements.exits, movements.adjustments, movements.compensations].every(count)
    || !money(movements.entriesCost) || !money(movements.exitsCost) || !money(movements.exitsSale)) throw invalid();
  const units = value.units.map((unit) => {
    if (!object(unit) || !text(unit.unit, 20) || !quantity(unit.entryQuantity) || !quantity(unit.exitQuantity) || !signedQuantity(unit.adjustmentDelta) || !signedQuantity(unit.compensationDelta)) throw invalid();
    return { unit: unit.unit, entryQuantity: unit.entryQuantity, exitQuantity: unit.exitQuantity, adjustmentDelta: unit.adjustmentDelta, compensationDelta: unit.compensationDelta };
  });
  const categories = value.categories.map((category) => {
    if (!object(category) || !text(category.id, 100) || !text(category.name) || !count(category.products) || !money(category.estimatedCost)) throw invalid();
    return { id: category.id, name: category.name, products: category.products, estimatedCost: category.estimatedCost };
  });
  const series = value.series.map(point);
  const from = period.from as string; const to = period.to as string;
  if (series.some((entry, index) => entry.from < from || entry.to > to || index > 0 && entry.from <= series[index - 1].to)) throw invalid();
  return {
    generatedAt: value.generatedAt, period: { from: value.period.from, to: value.period.to, granularity: value.period.granularity as "day" | "month", timeZone: "America/Sao_Paulo" },
    current: { products: current.products as number, activeProducts: current.activeProducts as number, inactiveProducts: current.inactiveProducts as number, lowStock: current.lowStock as number, emptyStock: current.emptyStock as number, estimatedCost: current.estimatedCost, potentialSale: current.potentialSale, estimatedMargin: current.estimatedMargin },
    movements: { entries: movements.entries as number, exits: movements.exits as number, adjustments: movements.adjustments as number, compensations: movements.compensations as number, entriesCost: movements.entriesCost, exitsCost: movements.exitsCost, exitsSale: movements.exitsSale },
    units, series, mostMoved: value.mostMoved.map(moved), highestValue: value.highestValue.map(product), categories, warnings: value.warnings as string[]
  };
}

export async function getDashboard(query: string, signal?: AbortSignal): Promise<DashboardDTO> {
  let response: Response;
  try {
    response = await fetch(`/api/dashboard${query ? `?${query}` : ""}`, { credentials: "same-origin", cache: "no-store", signal: signal ?? AbortSignal.timeout(30000) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new DashboardRequestError("A conexão foi interrompida. Tente atualizar os indicadores.", 0);
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new DashboardRequestError(object(result) && typeof result.message === "string" ? result.message : "Não foi possível consultar os indicadores. Tente novamente.", response.status);
  return parseDashboard(result);
}
export const dashboardError = (error: unknown): string => error instanceof Error ? error.message : "Não foi possível consultar os indicadores. Tente novamente.";
