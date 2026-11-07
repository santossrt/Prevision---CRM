import { stockRead } from "@/server/stock/http";
import { listBalances } from "@/server/stock/service";

export const runtime = "nodejs";
export const GET = stockRead(listBalances);
