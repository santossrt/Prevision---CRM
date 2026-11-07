export type InventoryStatus = "OPEN" | "COMPLETED" | "CANCELED";
export interface InventoryPerson { id: string; name: string | null }
export interface InventorySummaryDTO {
  id: string;
  title: string;
  status: InventoryStatus;
  version: number;
  openedAt: string;
  completedAt: string | null;
  canceledAt: string | null;
  createdBy: InventoryPerson;
  completedBy: InventoryPerson | null;
  canceledBy: InventoryPerson | null;
  itemCount: number;
  countedItems: number;
  divergentItems: number;
  changedItems: number;
}
export interface InventoryItemDTO {
  productId: string;
  name: string;
  sku: string;
  unitOfMeasure: string;
  categoryName: string;
  productIsActive: boolean;
  baselineQuantity: string;
  baselineVersion: number;
  currentQuantity: string;
  currentBalanceVersion: number;
  countedQuantity: string | null;
  difference: string | null;
  justification: string | null;
  countedBy: InventoryPerson | null;
  countedAt: string | null;
  stockChanged: boolean;
  movementId: string | null;
}
export interface InventoryDTO extends InventorySummaryDTO {
  notes: string | null;
  items: InventoryItemDTO[];
}
export interface InventoryList {
  items: InventorySummaryDTO[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export type CreateInventoryInput = {
  title: string;
  notes?: string | null;
  idempotencyKey: string;
} & ({ scope: "all" } | { scope: "products"; productIds: string[] } | { scope: "categories"; categoryIds: string[] });
export interface CountInventoryInput {
  expectedVersion: number;
  idempotencyKey: string;
  items: { productId: string; countedQuantity: string; justification?: string | null }[];
}
export interface RebaseInventoryInput { expectedVersion: number; idempotencyKey: string; productIds: string[] }
export interface InventoryActionInput { expectedVersion: number; idempotencyKey: string }
export interface InventoryMutationResult { inventory: InventoryDTO; replayed: boolean }
