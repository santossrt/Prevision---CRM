import { createProduct, listProducts } from "@/server/catalog/service";
import { catalogCollectionHandlers } from "@/server/http/catalog-routes";

export const runtime = "nodejs";
export const { GET, POST } = catalogCollectionHandlers("products", "Produto", listProducts, createProduct);
