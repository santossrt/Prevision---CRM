export type MovementType = "ENTRY" | "EXIT" | "POSITIVE_ADJUSTMENT" | "NEGATIVE_ADJUSTMENT" | "COMPENSATION";
export type NewMovementType = Exclude<MovementType, "COMPENSATION">;
export interface StockProductDTO {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  isActive: boolean;
  unitOfMeasure: string;
  category: { id: string; name: string; isActive: boolean };
  defaultSupplierId: string | null;
  quantity: string;
  version: number;
  minimumStock: string;
  acquisitionCost: string;
  salePrice: string;
  stockStatus: "empty" | "low" | "normal";
  estimatedCost: string;
  potentialSale: string;
  estimatedMargin: string;
}
export interface StockMovementDTO {
  id: string;
  productId: string;
  product: { id: string; name: string; sku: string; unitOfMeasure: string };
  type: MovementType;
  quantityDelta: string;
  quantityBefore: string;
  quantityAfter: string;
  historicalUnitCost: string;
  historicalTotalCost: string;
  historicalUnitPrice: string | null;
  historicalTotalPrice: string | null;
  supplier: { id: string; name: string } | null;
  customer: { id: string; name: string } | null;
  performedBy: { id: string; name: string | null };
  occurredAt: string;
  createdAt: string;
  notes: string | null;
  justification: string | null;
  operationId: string;
  compensatesMovementId: string | null;
  compensationId: string | null;
}
export interface StockList<T> { items: T[]; total: number; page: number; pageSize: number; totalPages: number }
export interface StockBalances extends StockList<StockProductDTO> {
  summary: { products: number; estimatedCost: string; potentialSale: string; estimatedMargin: string };
}
export interface StockOptions {
  categories: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
  customers: { id: string; name: string }[];
}
export interface CreateMovementInput {
  type: NewMovementType;
  productId: string;
  quantity: string;
  unitCost?: string;
  unitPrice?: string;
  supplierId?: string | null;
  customerId?: string | null;
  occurredAt: string;
  notes?: string | null;
  justification?: string | null;
  idempotencyKey: string;
}
export interface CompensateMovementInput {
  justification: string;
  idempotencyKey: string;
}
export interface MovementResult { movement: StockMovementDTO; replayed: boolean }
