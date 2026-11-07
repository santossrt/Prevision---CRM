import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import type { MovementResult, StockBalances, StockList, StockMovementDTO, StockOptions, StockProductDTO } from "../../lib/stock/types.ts";
import type { Principal } from "../auth/identity.ts";
import { lockAuthState } from "../auth/sessions.ts";
import { assertActorInTransaction, assertPermission } from "../authorization/guard.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { fixed, movementTotal, resultingQuantity, totalCents } from "./calculations.ts";
import { balanceQuerySchema, compensationCreateSchema, movementCreateSchema, movementQuerySchema, parseStockQuery, stockIdSchema } from "./validation.ts";

const productInclude = { category: { select: { id: true, name: true, isActive: true } }, stockBalance: true } as const satisfies Prisma.ProductInclude;
const movementInclude = {
  product: { select: { id: true, name: true, sku: true, unitOfMeasure: true } },
  supplier: { select: { id: true, name: true } }, customer: { select: { id: true, name: true } },
  performedBy: { select: { id: true, name: true } }, compensation: { select: { id: true } }
} as const satisfies Prisma.StockMovementInclude;
type ProductRecord = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type MovementRecord = Prisma.StockMovementGetPayload<{ include: typeof movementInclude }>;
type Transaction = Prisma.TransactionClient;
type Permission = "stock.write" | "stock.adjust";
type NewMovement = z.output<typeof movementCreateSchema>;
type LockedBalance = { productId: string; quantity: Prisma.Decimal; version: number };

function id(value: string): string {
  const result = stockIdSchema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION", "Identificador de estoque inválido.");
  return result.data;
}
const missing = () => new ApplicationError("NOT_FOUND", "Registro de estoque não encontrado.");
const conflict = () => new ApplicationError("CONFLICT", "Esta solicitação já foi utilizada para outra operação. Atualize a página e confira o histórico.");

function productDTO(record: ProductRecord): StockProductDTO {
  const balance = record.stockBalance;
  if (!balance) throw new ApplicationError("UNAVAILABLE", "O saldo inicial deste produto precisa ser verificado.");
  const quantity = balance.quantity.toFixed(4);
  const acquisitionCost = record.acquisitionCost.toFixed(4);
  const salePrice = record.salePrice.toFixed(4);
  const cost = totalCents(quantity, acquisitionCost);
  const sale = totalCents(quantity, salePrice);
  return {
    id: record.id, name: record.name, sku: record.sku, barcode: record.barcode, isActive: record.isActive,
    unitOfMeasure: record.unitOfMeasure, category: record.category, defaultSupplierId: record.defaultSupplierId,
    quantity, version: balance.version, minimumStock: record.minimumStock.toFixed(4), acquisitionCost, salePrice,
    stockStatus: balance.quantity.isZero() ? "empty" : balance.quantity.lte(record.minimumStock) ? "low" : "normal",
    estimatedCost: fixed(cost, 2), potentialSale: fixed(sale, 2), estimatedMargin: fixed(sale - cost, 2)
  };
}
function movementDTO(record: MovementRecord): StockMovementDTO {
  return {
    id: record.id, productId: record.productId, product: record.product, type: record.type,
    quantityDelta: record.quantityDelta.toFixed(4), quantityBefore: record.quantityBefore.toFixed(4), quantityAfter: record.quantityAfter.toFixed(4),
    historicalUnitCost: record.historicalUnitCost.toFixed(4), historicalTotalCost: record.historicalTotalCost.toFixed(2),
    historicalUnitPrice: record.historicalUnitPrice?.toFixed(4) ?? null, historicalTotalPrice: record.historicalTotalPrice?.toFixed(2) ?? null,
    supplier: record.supplier, customer: record.customer, performedBy: record.performedBy,
    occurredAt: record.occurredAt.toISOString(), createdAt: record.createdAt.toISOString(), notes: record.notes, justification: record.justification,
    operationId: record.operationId, compensatesMovementId: record.compensatesMovementId, compensationId: record.compensation?.id ?? null
  };
}

async function read<T>(actor: Principal, work: (tx: Transaction) => Promise<T>): Promise<T> {
  assertPermission(actor, "stock.read");
  await verifyDatabaseIdentity();
  return getDatabase().$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 15000 });
}
async function write<T>(actor: Principal, permission: Permission, work: (tx: Transaction) => Promise<T>): Promise<T> {
  assertPermission(actor, permission);
  await verifyDatabaseIdentity();
  try {
    return await getDatabase().$transaction(async (tx) => {
      // Match catalog's lock order so status/value edits and permission changes
      // cannot race with the financial snapshot. READ COMMITTED sees changes
      // committed while this request waited for either authorization lock.
      await lockAuthState(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026103003)`;
      await assertActorInTransaction(tx, actor, permission);
      return work(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") throw conflict();
      if (["P2025", "P2028", "P2034"].includes(error.code)) throw new ApplicationError("CONFLICT", "Outra operação alterou o estoque. Atualize e tente novamente.");
    }
    throw error;
  }
}
async function lockBalance(tx: Transaction, productId: string): Promise<LockedBalance> {
  const records = await tx.$queryRaw<LockedBalance[]>`SELECT product_id AS "productId", quantity, version FROM stock_balances WHERE product_id = ${productId}::uuid FOR UPDATE`;
  if (!records[0]) throw new ApplicationError("UNAVAILABLE", "O saldo inicial deste produto precisa ser verificado.");
  if (records[0].version >= 2147483647) throw new ApplicationError("UNAVAILABLE", "O controle de versão deste saldo precisa ser verificado.");
  return records[0];
}

function fingerprint(actor: Principal, operation: string, input: unknown) {
  return createHash("sha256").update(JSON.stringify({ actorId: actor.id, operation, input })).digest("hex");
}
function canonical(input: NewMovement) {
  return {
    type: input.type, productId: input.productId, quantity: input.quantity, occurredAt: input.occurredAt, notes: input.notes ?? null,
    unitCost: input.type === "ENTRY" ? input.unitCost : null, supplierId: input.type === "ENTRY" ? input.supplierId : null,
    unitPrice: input.type === "EXIT" ? input.unitPrice : null, customerId: input.type === "EXIT" ? input.customerId ?? null : null,
    justification: input.type === "POSITIVE_ADJUSTMENT" || input.type === "NEGATIVE_ADJUSTMENT" ? input.justification : null
  };
}
async function replay(tx: Transaction, actor: Principal, key: string, hash: string): Promise<MovementResult | null> {
  const existing = await tx.stockMovement.findUnique({ where: { idempotencyKey: key }, include: movementInclude });
  if (!existing) return null;
  if (existing.performedById !== actor.id || existing.requestHash !== hash) throw conflict();
  return { movement: movementDTO(existing), replayed: true };
}
async function audit(tx: Transaction, actor: Principal, movement: MovementRecord) {
  const actions = { ENTRY: "STOCK_ENTRY", EXIT: "STOCK_EXIT", POSITIVE_ADJUSTMENT: "STOCK_ADJUSTMENT", NEGATIVE_ADJUSTMENT: "STOCK_ADJUSTMENT", COMPENSATION: "STOCK_COMPENSATION" } as const;
  await tx.auditEvent.create({ data: {
    actorId: actor.id, action: actions[movement.type], module: "STOCK", entityType: "StockMovement", entityId: movement.id,
    operationId: movement.operationId, origin: "stock",
    previousValues: { productId: movement.productId, quantity: movement.quantityBefore.toFixed(4) },
    newValues: {
      productId: movement.productId, type: movement.type, quantityDelta: movement.quantityDelta.toFixed(4), quantity: movement.quantityAfter.toFixed(4),
      historicalUnitCost: movement.historicalUnitCost.toFixed(4), historicalTotalCost: movement.historicalTotalCost.toFixed(2),
      historicalUnitPrice: movement.historicalUnitPrice?.toFixed(4) ?? null, historicalTotalPrice: movement.historicalTotalPrice?.toFixed(2) ?? null,
      supplierId: movement.supplierId, customerId: movement.customerId, compensatesMovementId: movement.compensatesMovementId,
      justification: movement.justification, occurredAt: movement.occurredAt.toISOString()
    }
  } });
}
async function activeParty(tx: Transaction, kind: "supplier" | "customer", partyId: string) {
  const record = kind === "supplier" ? await tx.supplier.findUnique({ where: { id: partyId }, select: { isActive: true } })
    : await tx.customer.findUnique({ where: { id: partyId }, select: { isActive: true } });
  if (!record?.isActive) throw new ApplicationError("VALIDATION", kind === "supplier" ? "Selecione um fornecedor ativo." : "Selecione um cliente ativo.");
}

export async function createMovement(actor: Principal, body: unknown): Promise<MovementResult> {
  const input = movementCreateSchema.parse(body);
  const permission = input.type === "POSITIVE_ADJUSTMENT" || input.type === "NEGATIVE_ADJUSTMENT" ? "stock.adjust" : "stock.write";
  const hash = fingerprint(actor, "create", canonical(input));
  return write(actor, permission, async (tx) => {
    const existing = await replay(tx, actor, input.idempotencyKey, hash);
    if (existing) return existing;
    if (new Date(input.occurredAt).getTime() > Date.now() + 5 * 60 * 1000) throw new ApplicationError("VALIDATION", "A data da movimentação não pode estar no futuro.");
    const product = await tx.product.findUnique({ where: { id: input.productId } });
    if (!product) throw missing();
    if (!product.isActive) throw new ApplicationError("VALIDATION", "Selecione um produto ativo para movimentar o estoque.");
    if (input.type === "ENTRY") await activeParty(tx, "supplier", input.supplierId);
    if (input.type === "EXIT" && input.customerId) await activeParty(tx, "customer", input.customerId);
    const balance = await lockBalance(tx, product.id);
    const before = balance.quantity.toFixed(4);
    const negative = input.type === "EXIT" || input.type === "NEGATIVE_ADJUSTMENT";
    const delta = negative ? `-${input.quantity}` : input.quantity;
    const after = resultingQuantity(before, delta);
    const unitCost = input.type === "ENTRY" ? input.unitCost : product.acquisitionCost.toFixed(4);
    const unitPrice = input.type === "EXIT" ? input.unitPrice : null;
    const totalCost = movementTotal(input.quantity, unitCost);
    const totalPrice = unitPrice === null ? null : movementTotal(input.quantity, unitPrice);
    const now = new Date();
    const movement = await tx.stockMovement.create({ data: {
      productId: product.id, type: input.type, quantityDelta: delta, quantityBefore: before, quantityAfter: after,
      historicalUnitCost: unitCost, historicalTotalCost: totalCost, historicalUnitPrice: unitPrice, historicalTotalPrice: totalPrice,
      supplierId: input.type === "ENTRY" ? input.supplierId : null, customerId: input.type === "EXIT" ? input.customerId ?? null : null,
      performedById: actor.id, occurredAt: new Date(input.occurredAt), createdAt: now, notes: input.notes ?? null,
      justification: input.type === "POSITIVE_ADJUSTMENT" || input.type === "NEGATIVE_ADJUSTMENT" ? input.justification : null,
      operationId: randomUUID(), idempotencyKey: input.idempotencyKey, requestHash: hash
    }, include: movementInclude });
    await tx.stockBalance.update({ where: { productId: product.id }, data: { quantity: after, version: { increment: 1 } } });
    await audit(tx, actor, movement);
    return { movement: movementDTO(movement), replayed: false };
  });
}

export async function compensateMovement(actor: Principal, movementId: string, body: unknown): Promise<MovementResult> {
  const targetId = id(movementId);
  const input = compensationCreateSchema.parse(body);
  const hash = fingerprint(actor, "compensate", { movementId: targetId, justification: input.justification });
  return write(actor, "stock.adjust", async (tx) => {
    const existing = await replay(tx, actor, input.idempotencyKey, hash);
    if (existing) return existing;
    const original = await tx.stockMovement.findUnique({ where: { id: targetId }, include: movementInclude });
    if (!original) throw missing();
    if (original.type === "COMPENSATION") throw new ApplicationError("CONFLICT", "Uma compensação não pode ser compensada novamente. Registre um ajuste justificado, se necessário.");
    if (original.compensation) throw new ApplicationError("CONFLICT", "Esta movimentação já possui uma compensação.");
    const balance = await lockBalance(tx, original.productId);
    const before = balance.quantity.toFixed(4);
    const delta = original.quantityDelta.negated().toFixed(4);
    const after = resultingQuantity(before, delta);
    const now = new Date();
    const movement = await tx.stockMovement.create({ data: {
      productId: original.productId, type: "COMPENSATION", quantityDelta: delta, quantityBefore: before, quantityAfter: after,
      historicalUnitCost: original.historicalUnitCost, historicalTotalCost: original.historicalTotalCost,
      historicalUnitPrice: original.historicalUnitPrice, historicalTotalPrice: original.historicalTotalPrice,
      supplierId: original.supplierId, customerId: original.customerId, performedById: actor.id,
      occurredAt: now, createdAt: now, justification: input.justification, operationId: randomUUID(),
      idempotencyKey: input.idempotencyKey, requestHash: hash, compensatesMovementId: original.id
    }, include: movementInclude });
    await tx.stockBalance.update({ where: { productId: original.productId }, data: { quantity: after, version: { increment: 1 } } });
    await audit(tx, actor, movement);
    return { movement: movementDTO(movement), replayed: false };
  });
}

export function getStockProduct(actor: Principal, productId: string): Promise<StockProductDTO> {
  const targetId = id(productId);
  return read(actor, async (tx) => {
    const record = await tx.product.findUnique({ where: { id: targetId }, include: productInclude });
    if (!record) throw missing();
    return productDTO(record);
  });
}
export function getMovement(actor: Principal, movementId: string): Promise<StockMovementDTO> {
  const targetId = id(movementId);
  return read(actor, async (tx) => {
    const record = await tx.stockMovement.findUnique({ where: { id: targetId }, include: movementInclude });
    if (!record) throw missing();
    return movementDTO(record);
  });
}
export function getStockOptions(actor: Principal): Promise<StockOptions> {
  return read(actor, async (tx) => {
    const [categories, suppliers, customers] = await Promise.all([
      tx.category.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
      tx.supplier.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] }),
      tx.customer.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] })
    ]);
    return { categories, suppliers, customers };
  });
}

function searchPattern(search: string) { return `%${search.replace(/[!%_]/g, (character) => `!${character}`)}%`; }
export function listBalances(actor: Principal, search: URLSearchParams): Promise<StockBalances> {
  const query = parseStockQuery(balanceQuerySchema, search);
  return read(actor, async (tx) => {
    const clauses: Prisma.Sql[] = [];
    if (query.status !== "all") clauses.push(Prisma.sql`p.is_active = ${query.status === "active"}`);
    if (query.categoryId) clauses.push(Prisma.sql`p.category_id = ${query.categoryId}::uuid`);
    if (query.stock === "empty") clauses.push(Prisma.sql`b.quantity = 0`);
    if (query.stock === "low") clauses.push(Prisma.sql`b.quantity > 0 AND b.quantity <= p.minimum_stock`);
    if (query.stock === "normal") clauses.push(Prisma.sql`b.quantity > p.minimum_stock`);
    if (query.search) {
      const pattern = searchPattern(query.search);
      clauses.push(Prisma.sql`(p.name ILIKE ${pattern} ESCAPE '!' OR p.sku ILIKE ${pattern} ESCAPE '!' OR p.barcode ILIKE ${pattern} ESCAPE '!')`);
    }
    const where = clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}` : Prisma.empty;
    const [summary] = await tx.$queryRaw<{ total: number; cost: string; sale: string; margin: string }[]>`SELECT count(*)::int AS total,
      COALESCE(sum(round(b.quantity * p.acquisition_cost, 2)), 0)::text AS cost,
      COALESCE(sum(round(b.quantity * p.sale_price, 2)), 0)::text AS sale,
      COALESCE(sum(round(b.quantity * p.sale_price, 2) - round(b.quantity * p.acquisition_cost, 2)), 0)::text AS margin
      FROM products p JOIN stock_balances b ON b.product_id = p.id ${where}`;
    const ids = await tx.$queryRaw<{ id: string }[]>`SELECT p.id FROM products p JOIN stock_balances b ON b.product_id = p.id ${where}
      ORDER BY p.name ASC, p.id ASC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
    const records = await tx.product.findMany({ where: { id: { in: ids.map((record) => record.id) } }, include: productInclude });
    const byId = new Map(records.map((record) => [record.id, record]));
    const total = summary?.total ?? 0;
    return {
      items: ids.map((record) => productDTO(byId.get(record.id)!)), total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize),
      summary: { products: total, estimatedCost: new Prisma.Decimal(summary?.cost ?? 0).toFixed(2), potentialSale: new Prisma.Decimal(summary?.sale ?? 0).toFixed(2), estimatedMargin: new Prisma.Decimal(summary?.margin ?? 0).toFixed(2) }
    };
  });
}
export function listMovements(actor: Principal, search: URLSearchParams): Promise<StockList<StockMovementDTO>> {
  const query = parseStockQuery(movementQuerySchema, search);
  return read(actor, async (tx) => {
    const clauses: Prisma.Sql[] = [];
    if (query.productId) clauses.push(Prisma.sql`m.product_id = ${query.productId}::uuid`);
    if (query.type) clauses.push(Prisma.sql`m.type = ${query.type}::"StockMovementType"`);
    if (query.from) clauses.push(Prisma.sql`m.occurred_at >= ${new Date(query.from)}::timestamptz`);
    if (query.to) clauses.push(Prisma.sql`m.occurred_at <= ${new Date(query.to)}::timestamptz`);
    if (query.search) {
      const pattern = searchPattern(query.search);
      clauses.push(Prisma.sql`(p.name ILIKE ${pattern} ESCAPE '!' OR p.sku ILIKE ${pattern} ESCAPE '!' OR p.barcode ILIKE ${pattern} ESCAPE '!')`);
    }
    const where = clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}` : Prisma.empty;
    const [count] = await tx.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM stock_movements m JOIN products p ON p.id = m.product_id ${where}`;
    const ids = await tx.$queryRaw<{ id: string }[]>`SELECT m.id FROM stock_movements m JOIN products p ON p.id = m.product_id ${where}
      ORDER BY m.occurred_at DESC, m.id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
    const records = await tx.stockMovement.findMany({ where: { id: { in: ids.map((record) => record.id) } }, include: movementInclude });
    const byId = new Map(records.map((record) => [record.id, record]));
    const total = count?.total ?? 0;
    return { items: ids.map((record) => movementDTO(byId.get(record.id)!)), total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
  });
}
