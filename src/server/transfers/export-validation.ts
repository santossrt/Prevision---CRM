import { z } from "zod";
import { AuditAction, AuditModule } from "../../generated/prisma/enums.ts";
import type { ReportFilters, ReportKind } from "../../lib/transfers/types.ts";
import { REPORT_SOURCE_PERMISSION } from "../../lib/transfers/access.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { parseAnalysisFilters } from "../analyses/validation.ts";
import { parseDashboardPeriod } from "../dashboard/validation.ts";

export const reportKinds = ["products", "stock", "low_stock", "empty_stock", "entries", "exits", "adjustments", "movements", "inventories", "audit", "abc", "replenishment", "indicators"] as const;
const text = (maximum: number) => z.string().trim().max(maximum).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const id = z.string().uuid().transform((value) => value.toLowerCase());
const date = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const common = { search: text(100).optional() };
const period = { from: date.optional(), to: date.optional() };
const balance = { ...common, status: z.enum(["all", "active", "inactive"]).default("all"), categoryId: id.optional(), supplierId: id.optional() };
const movement = { ...common, ...period, productId: id.optional() };
const movementTypes = z.enum(["ENTRY", "EXIT", "POSITIVE_ADJUSTMENT", "NEGATIVE_ADJUSTMENT", "COMPENSATION"]);
const schemas = {
  products: z.object({ ...balance, stock: z.enum(["all", "normal", "low", "empty"]).default("all") }).strict(),
  stock: z.object({ ...balance, stock: z.enum(["all", "normal", "low", "empty"]).default("all") }).strict(),
  low_stock: z.object(balance).strict(),
  empty_stock: z.object(balance).strict(),
  entries: z.object(movement).strict(),
  exits: z.object(movement).strict(),
  adjustments: z.object(movement).strict(),
  movements: z.object({ ...movement, type: movementTypes.optional() }).strict(),
  inventories: z.object({ ...common, ...period, status: z.enum(["all", "OPEN", "COMPLETED", "CANCELED"]).default("all"), inventoryId: id.optional() }).strict(),
  audit: z.object({ ...common, ...period, actorId: id.optional(), module: z.enum(AuditModule).optional(), action: z.enum(AuditAction).optional(), entityType: text(80).min(1).optional(), entityId: text(128).min(1).optional(), operationId: id.optional() }).strict()
};
const request = z.object({ kind: z.enum(reportKinds), filters: z.record(z.string(), z.string()).default({}) }).strict();

export function parseReportPreview(body: unknown): { kind: ReportKind; filters: ReportFilters } {
  const value = request.parse(body);
  if (value.kind === "abc" || value.kind === "replenishment") {
    const parsed = parseAnalysisFilters(new URLSearchParams(value.filters));
    return { kind: value.kind, filters: Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, String(entry)])) };
  }
  if (value.kind === "indicators") {
    const parsed = parseDashboardPeriod(new URLSearchParams(value.filters));
    return { kind: value.kind, filters: { from: parsed.from, to: parsed.to } };
  }
  const filters = schemas[value.kind].parse(value.filters) as ReportFilters;
  if (filters.from && filters.to && filters.from > filters.to) throw new ApplicationError("VALIDATION", "A data inicial deve ser anterior ou igual à data final.");
  return { kind: value.kind, filters };
}
export function reportId(value: string): string {
  const parsed = id.safeParse(value);
  if (!parsed.success) throw new ApplicationError("VALIDATION", "Identificador de relatório inválido.");
  return parsed.data;
}
export function downloadFormat(search: URLSearchParams): "xlsx" | "pdf" {
  if (search.size !== 1 || !["xlsx", "pdf"].includes(search.get("format") ?? "")) throw new ApplicationError("VALIDATION", "Escolha Excel ou PDF para baixar o relatório.");
  return search.get("format") as "xlsx" | "pdf";
}
export const sourcePermission = (kind: ReportKind) => REPORT_SOURCE_PERMISSION[kind];
