import { stockRead } from "@/server/stock/http";
import { listStockAlerts } from "@/server/stock/alerts";

export const runtime = "nodejs";
export const GET = stockRead(listStockAlerts);
