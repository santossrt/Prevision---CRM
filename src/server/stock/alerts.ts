import "server-only";
import { Prisma } from "../../generated/prisma/client.ts";
import type { StockAlertDTO, StockAlertKind, StockAlertsList, StockAlertSummary } from "../../lib/stock/alerts-types.ts";
import type { Principal } from "../auth/identity.ts";
import { assertPermission } from "../authorization/guard.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { stockAlertQuerySchema } from "./alerts-validation.ts";
import { parseStockQuery } from "./validation.ts";

type Transaction = Prisma.TransactionClient;
type AlertRecord = {
  productId: string; name: string; sku: string; barcode: string | null;
  unitOfMeasure: string; quantity: string; minimumStock: string;
  kind: StockAlertKind; openedAt: Date; changedAt: Date;
};

async function read<T>(actor: Principal, work: (tx: Transaction) => Promise<T>): Promise<T> {
  assertPermission(actor, "stock.read");
  await verifyDatabaseIdentity();
  return getDatabase().$transaction(work, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 15000
  });
}

async function summary(tx: Transaction): Promise<StockAlertSummary> {
  const [counts] = await tx.$queryRaw<StockAlertSummary[]>`SELECT
    count(*) FILTER (WHERE a.kind = 'EMPTY')::int AS empty,
    count(*) FILTER (WHERE a.kind = 'LOW')::int AS low,
    count(*)::int AS total
    FROM stock_alerts a
    JOIN products p ON p.id = a.product_id
    JOIN stock_balances b ON b.product_id = p.id
    WHERE a.resolved_at IS NULL AND p.is_active`;
  return counts ?? { empty: 0, low: 0, total: 0 };
}

export async function getStockAlertSummary(actor: Principal): Promise<StockAlertSummary> {
  return read(actor, summary);
}

/** Active conditions only. Global summary intentionally ignores list filters. */
export async function listStockAlerts(actor: Principal, search: URLSearchParams): Promise<StockAlertsList> {
  assertPermission(actor, "stock.read");
  const query = parseStockQuery(stockAlertQuerySchema, search);
  return read(actor, async (tx) => {
    const clauses: Prisma.Sql[] = [Prisma.sql`a.resolved_at IS NULL`, Prisma.sql`p.is_active`];
    if (query.kind) clauses.push(Prisma.sql`a.kind = ${query.kind}::"public"."StockAlertKind"`);
    if (query.categoryId) clauses.push(Prisma.sql`p.category_id = ${query.categoryId}::uuid`);
    if (query.search) {
      const pattern = `%${query.search.replace(/[!%_]/g, (character) => `!${character}`)}%`;
      clauses.push(Prisma.sql`(p.name ILIKE ${pattern} ESCAPE '!' OR p.sku ILIKE ${pattern} ESCAPE '!' OR p.barcode ILIKE ${pattern} ESCAPE '!')`);
    }
    const where = Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}`;
    const counts = await summary(tx);
    const [count] = await tx.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total
      FROM stock_alerts a JOIN products p ON p.id = a.product_id
      JOIN stock_balances b ON b.product_id = p.id ${where}`;
    const records = await tx.$queryRaw<AlertRecord[]>`SELECT a.product_id AS "productId", p.name, p.sku, p.barcode,
      p.unit_of_measure AS "unitOfMeasure", b.quantity::text AS quantity, p.minimum_stock::text AS "minimumStock",
      a.kind, a.opened_at AS "openedAt", a.changed_at AS "changedAt"
      FROM stock_alerts a JOIN products p ON p.id = a.product_id
      JOIN stock_balances b ON b.product_id = p.id ${where}
      ORDER BY a.changed_at DESC, a.product_id ASC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
    const items: StockAlertDTO[] = records.map((record) => ({
      productId: record.productId, name: record.name, sku: record.sku, barcode: record.barcode,
      unitOfMeasure: record.unitOfMeasure, quantity: new Prisma.Decimal(record.quantity).toFixed(4),
      minimumStock: new Prisma.Decimal(record.minimumStock).toFixed(4), kind: record.kind,
      openedAt: record.openedAt.toISOString(), changedAt: record.changedAt.toISOString()
    }));
    const total = count?.total ?? 0;
    return { items, total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize), summary: counts };
  });
}
