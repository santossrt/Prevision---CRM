import { createCategory, listCategories } from "@/server/catalog/service";
import { catalogCollectionHandlers } from "@/server/http/catalog-routes";

export const runtime = "nodejs";
export const { GET, POST } = catalogCollectionHandlers("categories", "Categoria", listCategories, createCategory);
