"use client";
import type { AbcProduct, AnalysisDTO, AnalysisFilters, ReplenishmentProduct, ReplenishmentStatus } from "../../lib/analyses/types.ts";
import { validDashboardDay } from "../dashboard/dashboard-meta.ts";

export class AnalysisRequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max = 1000): value is string => typeof value === "string" && value.length <= max;
const decimal = (value: unknown, places: number): value is string => typeof value === "string" && new RegExp(`^\\d{1,100}\\.\\d{${places}}$`, "u").test(value);
const nullableDecimal = (value: unknown, places: number) => value === null || decimal(value, places);
const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
const classification = (value: unknown) => value === null || ["A", "B", "C"].includes(String(value));
const percent = (value: unknown): value is string => decimal(value, 2) && BigInt(value.replace(".", "")) <= 10000n;
const statuses = ["INACTIVE", "UNIT_CHANGED", "INSUFFICIENT_HISTORY", "NO_CONSUMPTION", "MISSING_LEAD_TIME", "REORDER", "OK"];
const invalid = () => new AnalysisRequestError("Não foi possível conferir a análise recebida. Atualize a consulta.", 0);
function common(value: Record<string, unknown>) { return id(value.id) && text(value.name) && text(value.sku, 64) && text(value.unit, 20) && typeof value.isActive === "boolean"; }
function abc(value: unknown): AbcProduct {
  if (!object(value) || !common(value) || typeof value.unitChanged !== "boolean" || typeof value.clamped !== "boolean" || !classification(value.classification)
    || ![value.grossExitQuantity, value.reversedExitQuantity].every((item) => decimal(item, 4)) || !nullableDecimal(value.netQuantity, 4)
    || ![value.grossExitCost, value.reversedExitCost, value.consumptionCost].every((item) => decimal(item, 2)) || !percent(value.share) || !percent(value.cumulativeShare)) throw invalid();
  if ((value.unitChanged && value.netQuantity !== null) || value.consumptionCost === "0.00" && value.classification !== null) throw invalid();
  return value as unknown as AbcProduct;
}
function replenishment(value: unknown): ReplenishmentProduct {
  if (!object(value) || !common(value) || !statuses.includes(String(value.status)) || ![value.quantity, value.minimumStock, value.safetyStock, value.minimumGap].every((item) => decimal(item, 4))
    || !(value.leadTimeDays === null || count(value.leadTimeDays)) || !(value.leadTimeSource === null || ["product", "supplier"].includes(String(value.leadTimeSource)))
    || !count(value.observedDays) || !count(value.positiveExitDays) || !nullableDecimal(value.netExitQuantity, 4) || !nullableDecimal(value.averageDaily, 8)
    || !nullableDecimal(value.daysUntilStockout, 2) || !nullableDecimal(value.reorderPoint, 4) || !nullableDecimal(value.recommendedQuantity, 4)
    || !(value.estimatedStockoutDate === null || validDashboardDay(value.estimatedStockoutDate)) || !(value.estimatedReorderDate === null || validDashboardDay(value.estimatedReorderDate)) || typeof value.dateLimited !== "boolean") throw invalid();
  if (!(value.supplier === null || object(value.supplier) && id(value.supplier.id) && text(value.supplier.name) && typeof value.supplier.isActive === "boolean")) throw invalid();
  const status = value.status as ReplenishmentStatus;
  if (["INACTIVE", "UNIT_CHANGED", "INSUFFICIENT_HISTORY", "NO_CONSUMPTION"].includes(status) && (value.averageDaily !== null || value.recommendedQuantity !== null || value.estimatedReorderDate !== null || value.estimatedStockoutDate !== null)) throw invalid();
  if (status === "MISSING_LEAD_TIME" && (value.leadTimeDays !== null || value.recommendedQuantity !== null || value.estimatedReorderDate !== null)) throw invalid();
  return value as unknown as ReplenishmentProduct;
}
export function parseAnalysis(value: unknown): AnalysisDTO {
  if (!object(value) || !text(value.generatedAt) || !/^\d{4}-\d{2}-\d{2}T/u.test(value.generatedAt) || !Number.isFinite(new Date(value.generatedAt).getTime()) || !validDashboardDay(value.asOfDate)
    || !object(value.filters) || !object(value.criteria) || !object(value.abc) || !object(value.replenishment) || !Array.isArray(value.warnings) || value.warnings.length > 30 || !value.warnings.every((item) => text(item, 2000))) throw invalid();
  const filters = value.filters;
  if (!validDashboardDay(filters.from) || !validDashboardDay(filters.to) || filters.from > filters.to || !text(filters.search, 100) || !["all", "active", "inactive"].includes(String(filters.status))
    || !percent(filters.thresholdA) || !percent(filters.thresholdB) || BigInt(filters.thresholdA.replace(".", "")) <= 0n || BigInt(filters.thresholdA.replace(".", "")) >= BigInt(filters.thresholdB.replace(".", "")) || filters.thresholdB === "100.00" || !count(filters.horizonDays) || filters.horizonDays < 1 || filters.horizonDays > 365) throw invalid();
  if (value.criteria.timeZone !== "America/Sao_Paulo" || !count(value.criteria.periodDays) || value.criteria.periodDays < 1 || value.criteria.periodDays > 366 || value.criteria.minimumHistoryDays !== 30 || value.criteria.minimumPositiveExitDays !== 2 || value.criteria.dateLimitDays !== 3650) throw invalid();
  if (!decimal(value.abc.totalConsumptionCost, 2) || !Array.isArray(value.abc.products) || value.abc.products.length > 1000 || !Array.isArray(value.abc.classes) || value.abc.classes.length !== 4
    || !Array.isArray(value.replenishment.products) || value.replenishment.products.length !== value.abc.products.length || !count(value.replenishment.reorderCount) || !count(value.replenishment.insufficientCount)) throw invalid();
  const products = value.abc.products.map(abc); const forecasts = value.replenishment.products.map(replenishment);
  const classes = value.abc.classes.map((entry) => {
    if (!object(entry) || !classification(entry.classification) || !count(entry.products) || !decimal(entry.consumptionCost, 2) || !percent(entry.share)) throw invalid();
    return entry as unknown as AnalysisDTO["abc"]["classes"][number];
  });
  if (new Set(products.map((product) => product.id)).size !== products.length || new Set(forecasts.map((product) => product.id)).size !== forecasts.length || forecasts.some((product) => !products.some((item) => item.id === product.id)) || new Set(classes.map((entry) => entry.classification)).size !== 4) throw invalid();
  return { generatedAt: value.generatedAt, asOfDate: value.asOfDate, filters: filters as unknown as AnalysisFilters, criteria: value.criteria as unknown as AnalysisDTO["criteria"], abc: { totalConsumptionCost: value.abc.totalConsumptionCost, products, classes }, replenishment: { products: forecasts, reorderCount: value.replenishment.reorderCount, insufficientCount: value.replenishment.insufficientCount }, warnings: value.warnings as string[] };
}
export async function getAnalysis(query: string, signal?: AbortSignal): Promise<AnalysisDTO> {
  let response: Response;
  try { response = await fetch(`/api/analyses${query ? `?${query}` : ""}`, { credentials: "same-origin", cache: "no-store", signal: signal ?? AbortSignal.timeout(30000) }); }
  catch (error) { if (signal?.aborted) throw error; throw new AnalysisRequestError("A conexão foi interrompida. Tente atualizar a análise.", 0); }
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new AnalysisRequestError(object(value) && typeof value.message === "string" ? value.message : "Não foi possível consultar as análises.", response.status);
  return parseAnalysis(value);
}
export const analysisError = (error: unknown): string => error instanceof Error ? error.message : "Não foi possível consultar a análise.";
