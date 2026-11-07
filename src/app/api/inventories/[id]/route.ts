import { stockItemRead } from "@/server/stock/http";
import { getInventory } from "@/server/inventory/service";

export const runtime = "nodejs";
export const GET = stockItemRead(getInventory);
