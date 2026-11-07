export type CatalogKind = "products" | "categories" | "suppliers" | "customers";
export type CatalogStatus = "active" | "inactive" | "all";
export type StockStatus = "empty" | "low" | "normal";
export interface CatalogList<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
export interface CatalogOption { id: string; name: string; isActive: boolean }
export interface CatalogOptions { categories: CatalogOption[]; suppliers: CatalogOption[] }
export interface CatalogRecord {
  id: string;
  name: string;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface CategoryDTO extends CatalogRecord { description: string | null }
export interface CustomerDTO extends CatalogRecord {
  taxId: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}
export interface SupplierDTO extends CustomerDTO { replenishmentLeadTimeDays: number | null }
export interface ProductDTO extends CatalogRecord {
  sku: string;
  barcode: string | null;
  description: string | null;
  categoryId: string;
  defaultSupplierId: string | null;
  category: CatalogOption;
  defaultSupplier: CatalogOption | null;
  unitOfMeasure: string;
  quantity: string;
  minimumStock: string;
  safetyStock: string;
  acquisitionCost: string;
  salePrice: string;
  replenishmentLeadTimeDays: number | null;
  stockStatus: StockStatus;
}
export interface ProductValueDTO {
  id: string;
  productId: string;
  type: "ACQUISITION_COST" | "SALE_PRICE";
  previousValue: string | null;
  newValue: string;
  changedBy: { id: string; name: string | null };
  effectiveAt: string;
  operationId: string;
}
export interface CategoryInput { name: string; description?: string | null; isActive?: boolean }
export interface CustomerInput {
  name: string;
  taxId?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  isActive?: boolean;
}
export interface SupplierInput extends CustomerInput { replenishmentLeadTimeDays?: number | null }
export interface ProductInput {
  name: string;
  sku: string;
  barcode?: string | null;
  description?: string | null;
  categoryId: string;
  defaultSupplierId?: string | null;
  unitOfMeasure?: string;
  minimumStock?: string;
  safetyStock?: string;
  acquisitionCost?: string;
  salePrice?: string;
  replenishmentLeadTimeDays?: number | null;
  isActive?: boolean;
}
export type CatalogUpdate<T> = Partial<T> & { expectedVersion: number };
