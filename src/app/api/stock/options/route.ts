import { stockRead } from "@/server/stock/http";
import { getStockOptions } from "@/server/stock/service";

export const runtime = "nodejs";
export const GET = stockRead(getStockOptions);
