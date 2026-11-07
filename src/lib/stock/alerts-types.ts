export type StockAlertKind = "EMPTY" | "LOW";
export interface StockAlertDTO {
  productId: string;
  name: string;
  sku: string;
  barcode: string | null;
  unitOfMeasure: string;
  quantity: string;
  minimumStock: string;
  kind: StockAlertKind;
  openedAt: string;
  changedAt: string;
}
export interface StockAlertSummary { empty: number; low: number; total: number }
export interface StockAlertsList {
  items: StockAlertDTO[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  summary: StockAlertSummary;
}
