import { stockItemRead } from "@/server/stock/http";
import { getMovement } from "@/server/stock/service";

export const runtime = "nodejs";
export const GET = stockItemRead(getMovement);
