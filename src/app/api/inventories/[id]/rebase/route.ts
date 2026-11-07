import { inventoryWrite } from "@/server/inventory/http";
import { rebaseInventory } from "@/server/inventory/service";

export const runtime = "nodejs";
export const POST = inventoryWrite(rebaseInventory);
