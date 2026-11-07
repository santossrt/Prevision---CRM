import { getCustomer, updateCustomer } from "@/server/catalog/service";
import { catalogItemHandlers } from "@/server/http/catalog-routes";

export const runtime = "nodejs";
export const { GET, PATCH } = catalogItemHandlers("customers", getCustomer, updateCustomer);
