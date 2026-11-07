import { inventoryWrite } from "@/server/inventory/http";
import { countInventory } from "@/server/inventory/service";

export const runtime = "nodejs";
export const PATCH = inventoryWrite(countInventory);
