import { createSupplier, listSuppliers } from "@/server/catalog/service";
import { catalogCollectionHandlers } from "@/server/http/catalog-routes";

export const runtime = "nodejs";
export const { GET, POST } = catalogCollectionHandlers("suppliers", "Fornecedor", listSuppliers, createSupplier);
