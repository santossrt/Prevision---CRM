import type { ReportKind } from "./types.ts";

export const REPORT_SOURCE_PERMISSION: Readonly<Record<ReportKind, string>> = {
  products: "catalog.read", stock: "stock.read", low_stock: "stock.read", empty_stock: "stock.read",
  entries: "stock.read", exits: "stock.read", adjustments: "stock.read", movements: "stock.read",
  inventories: "stock.read", audit: "audit.read", abc: "stock.read", replenishment: "stock.read", indicators: "stock.read"
};
export function canImportProducts(permissions: readonly string[]): boolean {
  return permissions.includes("catalog.read") && permissions.includes("catalog.write");
}
export function canExportReport(permissions: readonly string[], kind: ReportKind): boolean {
  return permissions.includes("reports.read") && permissions.includes(REPORT_SOURCE_PERMISSION[kind]);
}
export function canUseTransfers(permissions: readonly string[]): boolean {
  return canImportProducts(permissions) || (Object.keys(REPORT_SOURCE_PERMISSION) as ReportKind[]).some((kind) => canExportReport(permissions, kind));
}
