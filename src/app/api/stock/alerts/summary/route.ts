import { stockRead } from "@/server/stock/http";
import { getStockAlertSummary } from "@/server/stock/alerts";

export const runtime = "nodejs";
export const GET = stockRead(getStockAlertSummary);
