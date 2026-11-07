import { inventoryWrite } from "@/server/inventory/http";
import { completeInventory } from "@/server/inventory/service";

export const runtime = "nodejs";
export const POST = inventoryWrite(completeInventory);
