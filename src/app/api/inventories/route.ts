import { stockRead } from "@/server/stock/http";
import { createInventory, listInventories } from "@/server/inventory/service";
import { inventoryCreate } from "@/server/inventory/http";

export const runtime = "nodejs";
export const GET = stockRead(listInventories);
export const POST = inventoryCreate(createInventory);
