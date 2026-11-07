import { getCategory, updateCategory } from "@/server/catalog/service";
import { catalogItemHandlers } from "@/server/http/catalog-routes";

export const runtime = "nodejs";
export const { GET, PATCH } = catalogItemHandlers("categories", getCategory, updateCategory);
