import "server-only";
import type { StockProductDTO } from "../../lib/stock/types.ts";
import type { Principal } from "../auth/identity.ts";
import { assertPermission } from "../authorization/guard.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { getStockProduct } from "./service.ts";

export function parseBarcodeQuery(query: URLSearchParams): string {
  if (query.size !== 1 || !query.has("code")) throw new ApplicationError("VALIDATION", "Informe somente um código de barras para consultar.");
  const raw = query.get("code")!;
  const code = raw.trim();
  if (!code || code.length > 128 || /[\u0000-\u001f\u007f]/u.test(raw) || /\s/u.test(code)) {
    throw new ApplicationError("VALIDATION", "Informe um código de barras válido, com até 128 caracteres e sem espaços.");
  }
  return code;
}

/** Exact equality preserves leading zeros and never substitutes a SKU search. */
export async function findProductByBarcode(actor: Principal, query: URLSearchParams): Promise<StockProductDTO> {
  assertPermission(actor, "stock.read");
  const code = parseBarcodeQuery(query);
  await verifyDatabaseIdentity();
  const record = await getDatabase().product.findUnique({ where: { barcode: code }, select: { id: true } });
  if (!record) throw new ApplicationError("NOT_FOUND", "Nenhum produto cadastrado com esse código de barras.");
  const product = await getStockProduct(actor, record.id);
  // A barcode can be edited between the lookup and the fresh stock read.
  if (product.barcode !== code) throw new ApplicationError("NOT_FOUND", "O código deste produto foi alterado. Leia ou informe o código novamente.");
  return product;
}
