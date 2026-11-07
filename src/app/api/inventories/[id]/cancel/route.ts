import { inventoryWrite } from "@/server/inventory/http";
import { cancelInventory } from "@/server/inventory/service";

export const runtime = "nodejs";
export const POST = inventoryWrite(cancelInventory);
