export interface TransferColumn { key: string; label: string }
export interface ImportIssue { column?: string; message: string }
export interface ImportPreviewRowDTO {
  rowNumber: number;
  data: Record<string, string>;
  errors: ImportIssue[];
}
export interface ImportPreviewDTO {
  id: string;
  fileName: string;
  format: "csv" | "xlsx";
  status: "PREVIEW" | "COMPLETED" | "EXPIRED";
  createdAt: string;
  expiresAt: string;
  rowCount: number;
  validCount: number;
  errorCount: number;
  createdCount: number;
  canConfirm: boolean;
  columns: TransferColumn[];
  rows: ImportPreviewRowDTO[];
  operationId: string;
}
export interface ImportResult { import: ImportPreviewDTO; replayed: boolean }
export interface ImportConfirmInput { idempotencyKey: string }
export type ReportKind = "products" | "stock" | "low_stock" | "empty_stock" | "entries" | "exits" | "adjustments" | "movements" | "inventories" | "audit" | "abc" | "replenishment" | "indicators";
export type ReportFilters = Record<string, string>;
export interface ReportPreviewInput { kind: ReportKind; filters: ReportFilters }
export interface ReportPreviewDTO {
  id: string;
  kind: ReportKind;
  title: string;
  generatedAt: string;
  expiresAt: string;
  generatedBy: { id: string; name: string | null };
  filters: ReportFilters;
  columns: TransferColumn[];
  rows: Record<string, string | null>[];
  rowCount: number;
  operationId: string;
  warnings: string[];
}
