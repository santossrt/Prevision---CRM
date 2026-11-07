import { stockItemWrite } from "@/server/stock/http";
import { compensateMovement } from "@/server/stock/service";

export const runtime = "nodejs";
export const POST = stockItemWrite(compensateMovement);
