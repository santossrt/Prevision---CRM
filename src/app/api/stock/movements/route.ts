import { stockRead, stockWrite } from "@/server/stock/http";
import { createMovement, listMovements } from "@/server/stock/service";

export const runtime = "nodejs";
export const GET = stockRead(listMovements);
export const POST = stockWrite(createMovement);
