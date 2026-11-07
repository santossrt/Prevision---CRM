import { stockItemRead } from "@/server/stock/http";
import { getStockProduct } from "@/server/stock/service";

export const runtime = "nodejs";
export const GET = stockItemRead(getStockProduct);
