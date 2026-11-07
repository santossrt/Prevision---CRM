import { findProductByBarcode } from "@/server/stock/barcode";
import { stockRead } from "@/server/stock/http";

export const runtime = "nodejs";
export const GET = stockRead(findProductByBarcode);
