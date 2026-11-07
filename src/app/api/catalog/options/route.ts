import { getCatalogOptions } from "@/server/catalog/service";
import { catalogReadHandler } from "@/server/http/catalog-routes";

export const runtime = "nodejs";
export const GET = catalogReadHandler("options", (actor) => getCatalogOptions(actor));
