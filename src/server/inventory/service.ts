import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import type { InventoryDTO, InventoryItemDTO, InventoryList, InventoryMutationResult, InventorySummaryDTO } from "../../lib/inventory/types.ts";
import type { Principal } from "../auth/identity.ts";
import { lockAuthState } from "../auth/sessions.ts";
import { assertActorInTransaction, assertPermission } from "../authorization/guard.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { fixed, movementTotal, scaled4 } from "../stock/calculations.ts";
import { parseStockQuery } from "../stock/validation.ts";
import { inventoryActionSchema, inventoryCountsSchema, inventoryCreateSchema, inventoryIdSchema, inventoryListSchema, inventoryRebaseSchema } from "./validation.ts";

const person = { id: true, name: true } as const;
const include = {
  createdBy: { select: person }, completedBy: { select: person }, canceledBy: { select: person },
  items: { include: { countedBy: { select: person }, product: { select: { isActive: true, unitOfMeasure: true, acquisitionCost: true, stockBalance: true } } }, orderBy: [{ name: "asc" }, { productId: "asc" }] }
} as const satisfies Prisma.InventoryInclude;
type Record = Prisma.InventoryGetPayload<{ include: typeof include }>;
type Tx = Prisma.TransactionClient;
type Kind = "CREATE" | "COUNT" | "REBASE" | "COMPLETE" | "CANCEL";
type Permission = "stock.write" | "stock.adjust";
type Balance = { productId: string; quantity: Prisma.Decimal; version: number };

const notFound = () => new ApplicationError("NOT_FOUND", "Inventário não encontrado.");
const stale = () => new ApplicationError("CONFLICT", "O inventário foi alterado por outra operação. Atualize e confira a versão atual.");
const keyConflict = () => new ApplicationError("CONFLICT", "Esta chave de solicitação já pertence a outra operação. Confira o inventário antes de tentar novamente.");
function id(value: string) {
  const parsed = inventoryIdSchema.safeParse(value);
  if (!parsed.success) throw new ApplicationError("VALIDATION", "Identificador de inventário inválido.");
  return parsed.data;
}
function itemDTO(record: Record["items"][number], open: boolean): InventoryItemDTO {
  const current = record.product.stockBalance;
  const changed = !current || current.version !== record.baselineVersion || !current.quantity.eq(record.baselineQuantity) || !record.product.isActive || record.product.unitOfMeasure !== record.unitOfMeasure;
  return {
    productId: record.productId, name: record.name, sku: record.sku, unitOfMeasure: record.unitOfMeasure, categoryName: record.categoryName,
    productIsActive: record.product.isActive, baselineQuantity: record.baselineQuantity.toFixed(4), baselineVersion: record.baselineVersion,
    currentQuantity: current?.quantity.toFixed(4) ?? record.baselineQuantity.toFixed(4), currentBalanceVersion: current?.version ?? -1,
    countedQuantity: record.countedQuantity?.toFixed(4) ?? null,
    difference: record.countedQuantity === null ? null : fixed(scaled4(record.countedQuantity.toFixed(4)) - scaled4(record.baselineQuantity.toFixed(4)), 4),
    justification: record.justification, countedBy: record.countedBy, countedAt: record.countedAt?.toISOString() ?? null,
    stockChanged: open && changed, movementId: record.movementId
  };
}
function summaryDTO(record: Record): InventorySummaryDTO {
  const items = record.items.map((item) => itemDTO(item, record.status === "OPEN"));
  return {
    id: record.id, title: record.title, status: record.status, version: record.version, openedAt: record.openedAt.toISOString(),
    completedAt: record.completedAt?.toISOString() ?? null, canceledAt: record.canceledAt?.toISOString() ?? null,
    createdBy: record.createdBy, completedBy: record.completedBy, canceledBy: record.canceledBy,
    itemCount: items.length, countedItems: items.filter((item) => item.countedQuantity !== null).length,
    divergentItems: items.filter((item) => item.difference !== null && item.difference !== "0.0000").length,
    changedItems: items.filter((item) => item.stockChanged).length
  };
}
const detailDTO = (record: Record): InventoryDTO => ({ ...summaryDTO(record), notes: record.notes, items: record.items.map((item) => itemDTO(item, record.status === "OPEN")) });
async function load(tx: Tx, inventoryId: string): Promise<Record> {
  const record = await tx.inventory.findUnique({ where: { id: inventoryId }, include });
  if (!record) throw notFound();
  return record;
}
async function locked(tx: Tx, inventoryId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM inventories WHERE id = ${inventoryId}::uuid FOR UPDATE`;
  if (!rows[0]) throw notFound();
  return load(tx, inventoryId);
}
function editable(record: Record, expected: number) {
  if (record.status !== "OPEN") throw new ApplicationError("CONFLICT", "Este inventário já foi encerrado e seu histórico está preservado.");
  if (record.version !== expected || record.version >= 2147483647) throw stale();
}
async function read<T>(actor: Principal, work: (tx: Tx) => Promise<T>) {
  assertPermission(actor, "stock.read");
  await verifyDatabaseIdentity();
  return getDatabase().$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 20000 });
}
async function write(actor: Principal, permission: Permission, work: (tx: Tx) => Promise<InventoryMutationResult>) {
  assertPermission(actor, permission);
  await verifyDatabaseIdentity();
  try {
    return await getDatabase().$transaction(async (tx) => {
      await lockAuthState(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026103003)`;
      await assertActorInTransaction(tx, actor, permission);
      return work(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 30000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") throw keyConflict();
      if (["P2025", "P2028", "P2034"].includes(error.code)) throw stale();
    }
    throw error;
  }
}
function hash(actor: Principal, kind: Kind, inventoryId: string | null, input: unknown): string {
  return createHash("sha256").update(JSON.stringify({ actorId: actor.id, kind, inventoryId, input })).digest("hex");
}
async function replay(tx: Tx, actor: Principal, key: string, kind: Kind, requestHash: string): Promise<InventoryMutationResult | null> {
  const operation = await tx.inventoryOperation.findUnique({ where: { key } });
  if (!operation) return null;
  if (operation.actorId !== actor.id || operation.kind !== kind || operation.requestHash !== requestHash) throw keyConflict();
  return { inventory: detailDTO(await load(tx, operation.inventoryId)), replayed: true };
}
async function finish(tx: Tx, actor: Principal, inventoryId: string, key: string, kind: Kind, requestHash: string): Promise<InventoryMutationResult> {
  await tx.inventoryOperation.create({ data: { key, actorId: actor.id, inventoryId, kind, requestHash } });
  return { inventory: detailDTO(await load(tx, inventoryId)), replayed: false };
}
async function audit(tx: Tx, actor: Principal, inventoryId: string, kind: Kind, operationId: string, before: Prisma.InputJsonObject | null, after: Prisma.InputJsonObject) {
  await tx.auditEvent.create({ data: {
    actorId: actor.id, action: kind === "CREATE" ? "CREATE" : "UPDATE", module: "INVENTORY", entityType: "Inventory", entityId: inventoryId,
    operationId, origin: `inventory.${kind.toLowerCase()}`, ...(before ? { previousValues: before } : {}), newValues: after
  } });
}
async function balances(tx: Tx, productIds: string[]) {
  const rows = await tx.$queryRaw<Balance[]>`SELECT product_id AS "productId", quantity, version FROM stock_balances
    WHERE product_id IN (${Prisma.join([...productIds].sort().map((productId) => Prisma.sql`${productId}::uuid`))}) ORDER BY product_id FOR UPDATE`;
  if (rows.length !== productIds.length) throw new ApplicationError("UNAVAILABLE", "O saldo de um produto precisa ser verificado antes de continuar.");
  return new Map(rows.map((row) => [row.productId, row]));
}

export async function listInventories(actor: Principal, search: URLSearchParams): Promise<InventoryList> {
  const query = parseStockQuery(inventoryListSchema, search);
  return read(actor, async (tx) => {
    const clauses: Prisma.Sql[] = [];
    if (query.status !== "all") clauses.push(Prisma.sql`status = ${query.status}::"InventoryStatus"`);
    if (query.search) clauses.push(Prisma.sql`title ILIKE ${`%${query.search.replace(/[!%_]/g, (character) => `!${character}`)}%`} ESCAPE '!'`);
    const where = clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}` : Prisma.empty;
    const [count] = await tx.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM inventories ${where}`;
    const ids = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM inventories ${where} ORDER BY opened_at DESC, id DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
    const records = await tx.inventory.findMany({ where: { id: { in: ids.map((item) => item.id) } }, include });
    const byId = new Map(records.map((record) => [record.id, record]));
    const total = count?.total ?? 0;
    return { items: ids.map((item) => summaryDTO(byId.get(item.id)!)), total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
  });
}
export async function getInventory(actor: Principal, inventoryId: string): Promise<InventoryDTO> {
  const targetId = id(inventoryId);
  return read(actor, async (tx) => detailDTO(await load(tx, targetId)));
}
export async function createInventory(actor: Principal, body: unknown): Promise<InventoryMutationResult> {
  const input = inventoryCreateSchema.parse(body);
  const canonical = { title: input.title, notes: input.notes ?? null, scope: input.scope, ids: input.scope === "products" ? input.productIds : input.scope === "categories" ? input.categoryIds : [] };
  const requestHash = hash(actor, "CREATE", null, canonical);
  return write(actor, "stock.write", async (tx) => {
    const previous = await replay(tx, actor, input.idempotencyKey, "CREATE", requestHash);
    if (previous) return previous;
    if (input.scope === "categories") {
      const categories = await tx.category.count({ where: { id: { in: input.categoryIds }, isActive: true } });
      if (categories !== input.categoryIds.length) throw new ApplicationError("VALIDATION", "Selecione somente categorias ativas e existentes.");
    }
    const products = await tx.product.findMany({
      where: { isActive: true, ...(input.scope === "products" ? { id: { in: input.productIds } } : input.scope === "categories" ? { categoryId: { in: input.categoryIds } } : {}) },
      include: { category: { select: { name: true } } }, orderBy: { id: "asc" }, take: 201
    });
    if (!products.length) throw new ApplicationError("VALIDATION", "Não há produtos ativos no escopo selecionado.");
    if (products.length > 200) throw new ApplicationError("VALIDATION", "O inventário admite até 200 produtos. Divida a conferência em categorias ou grupos menores.");
    if (input.scope === "products" && products.length !== input.productIds.length) throw new ApplicationError("VALIDATION", "Selecione somente produtos ativos e existentes.");
    const stock = await balances(tx, products.map((product) => product.id));
    const now = new Date();
    const inventory = await tx.inventory.create({ data: { title: input.title, notes: input.notes ?? null, createdById: actor.id, openedAt: now } });
    await tx.inventoryItem.createMany({ data: products.map((product) => ({
      inventoryId: inventory.id, productId: product.id, name: product.name, sku: product.sku, unitOfMeasure: product.unitOfMeasure,
      categoryName: product.category.name, baselineQuantity: stock.get(product.id)!.quantity, baselineVersion: stock.get(product.id)!.version
    })) });
    await audit(tx, actor, inventory.id, "CREATE", randomUUID(), null, { title: input.title, status: "OPEN", itemCount: products.length, scope: input.scope, productIds: products.map((product) => product.id), version: 0 });
    return finish(tx, actor, inventory.id, input.idempotencyKey, "CREATE", requestHash);
  });
}
export async function countInventory(actor: Principal, inventoryId: string, body: unknown): Promise<InventoryMutationResult> {
  const targetId = id(inventoryId);
  const input = inventoryCountsSchema.parse(body);
  const items = input.items.map((item) => ({ productId: item.productId, countedQuantity: item.countedQuantity, justification: item.justification ?? null }));
  const requestHash = hash(actor, "COUNT", targetId, { expectedVersion: input.expectedVersion, items });
  return write(actor, "stock.write", async (tx) => {
    const previous = await replay(tx, actor, input.idempotencyKey, "COUNT", requestHash);
    if (previous) return previous;
    const record = await locked(tx, targetId); editable(record, input.expectedVersion);
    const byId = new Map(record.items.map((item) => [item.productId, item]));
    for (const item of items) {
      const original = byId.get(item.productId);
      if (!original) throw new ApplicationError("VALIDATION", "A contagem contém um produto que não pertence a este inventário.");
      if (!original.product.isActive) throw new ApplicationError("CONFLICT", "Um produto foi inativado. Reative-o para continuar ou cancele o inventário.");
      if (original.product.unitOfMeasure !== original.unitOfMeasure) throw new ApplicationError("CONFLICT", "A unidade de um produto foi alterada. Cancele e inicie outro inventário para contar na unidade atual.");
      if (!original.baselineQuantity.eq(item.countedQuantity) && !item.justification) throw new ApplicationError("VALIDATION", "Justifique cada divergência antes de salvar a contagem.");
    }
    const now = new Date();
    for (const item of items) await tx.inventoryItem.update({ where: { inventoryId_productId: { inventoryId: targetId, productId: item.productId } }, data: { countedQuantity: item.countedQuantity, justification: item.justification, countedById: actor.id, countedAt: now } });
    await tx.inventory.update({ where: { id: targetId }, data: { version: { increment: 1 } } });
    await audit(tx, actor, targetId, "COUNT", randomUUID(), { version: record.version, items: items.map((item) => ({ productId: item.productId, countedQuantity: byId.get(item.productId)!.countedQuantity?.toFixed(4) ?? null })) }, { version: record.version + 1, items });
    return finish(tx, actor, targetId, input.idempotencyKey, "COUNT", requestHash);
  });
}
export async function rebaseInventory(actor: Principal, inventoryId: string, body: unknown): Promise<InventoryMutationResult> {
  const targetId = id(inventoryId);
  const input = inventoryRebaseSchema.parse(body);
  const requestHash = hash(actor, "REBASE", targetId, { expectedVersion: input.expectedVersion, productIds: input.productIds });
  return write(actor, "stock.write", async (tx) => {
    const previous = await replay(tx, actor, input.idempotencyKey, "REBASE", requestHash);
    if (previous) return previous;
    const record = await locked(tx, targetId); editable(record, input.expectedVersion);
    const byId = new Map(record.items.map((item) => [item.productId, item]));
    for (const productId of input.productIds) {
      const item = byId.get(productId);
      if (!item) throw new ApplicationError("VALIDATION", "Selecione apenas produtos deste inventário.");
      if (!item.product.isActive) throw new ApplicationError("CONFLICT", "Um produto foi inativado. Reative-o para atualizar a referência ou cancele o inventário.");
      if (item.product.unitOfMeasure !== item.unitOfMeasure) throw new ApplicationError("CONFLICT", "A unidade de um produto foi alterada. Cancele e inicie outro inventário para contar na unidade atual.");
    }
    const stock = await balances(tx, input.productIds);
    for (const productId of input.productIds) await tx.inventoryItem.update({ where: { inventoryId_productId: { inventoryId: targetId, productId } }, data: {
      baselineQuantity: stock.get(productId)!.quantity, baselineVersion: stock.get(productId)!.version,
      countedQuantity: null, justification: null, countedById: null, countedAt: null
    } });
    await tx.inventory.update({ where: { id: targetId }, data: { version: { increment: 1 } } });
    await audit(tx, actor, targetId, "REBASE", randomUUID(), { version: record.version, items: input.productIds.map((productId) => ({ productId, baselineQuantity: byId.get(productId)!.baselineQuantity.toFixed(4), countedQuantity: byId.get(productId)!.countedQuantity?.toFixed(4) ?? null })) }, { version: record.version + 1, items: input.productIds.map((productId) => ({ productId, baselineQuantity: stock.get(productId)!.quantity.toFixed(4), countedQuantity: null })) });
    return finish(tx, actor, targetId, input.idempotencyKey, "REBASE", requestHash);
  });
}
export async function completeInventory(actor: Principal, inventoryId: string, body: unknown): Promise<InventoryMutationResult> {
  const targetId = id(inventoryId);
  const input = inventoryActionSchema.parse(body);
  const requestHash = hash(actor, "COMPLETE", targetId, { expectedVersion: input.expectedVersion });
  return write(actor, "stock.adjust", async (tx) => {
    const previous = await replay(tx, actor, input.idempotencyKey, "COMPLETE", requestHash);
    if (previous) return previous;
    let record = await locked(tx, targetId); editable(record, input.expectedVersion);
    const stock = await balances(tx, record.items.map((item) => item.productId));
    record = await load(tx, targetId);
    const plans = record.items.map((item) => {
      const current = stock.get(item.productId)!;
      if (item.product.unitOfMeasure !== item.unitOfMeasure) throw new ApplicationError("CONFLICT", "A unidade de um produto foi alterada. Cancele e inicie outro inventário para contar na unidade atual.");
      if (!item.product.isActive || current.version !== item.baselineVersion || !current.quantity.eq(item.baselineQuantity)) throw new ApplicationError("CONFLICT", "O estoque mudou durante a contagem ou um produto foi inativado. Atualize a referência dos itens alterados e faça uma nova contagem antes de confirmar.");
      if (item.countedQuantity === null) throw new ApplicationError("VALIDATION", "Conte todos os produtos antes de confirmar o inventário.");
      const delta = scaled4(item.countedQuantity.toFixed(4)) - scaled4(item.baselineQuantity.toFixed(4));
      if (delta !== 0n && !item.justification?.trim()) throw new ApplicationError("VALIDATION", "Justifique todas as divergências antes de confirmar.");
      if (delta !== 0n && current.version >= 2147483647) throw new ApplicationError("UNAVAILABLE", "O controle de versão de um saldo precisa ser verificado.");
      return { item, delta, cost: item.product.acquisitionCost.toFixed(4), total: delta === 0n ? "0.00" : movementTotal(fixed(delta < 0n ? -delta : delta, 4), item.product.acquisitionCost.toFixed(4)) };
    });
    const operationId = randomUUID();
    const now = new Date();
    const movementIds: string[] = [];
    for (const plan of plans) {
      if (plan.delta === 0n) continue;
      const { item } = plan;
      const movement = await tx.stockMovement.create({ data: {
        productId: item.productId, type: plan.delta > 0n ? "POSITIVE_ADJUSTMENT" : "NEGATIVE_ADJUSTMENT",
        quantityDelta: fixed(plan.delta, 4), quantityBefore: item.baselineQuantity, quantityAfter: item.countedQuantity!,
        historicalUnitCost: plan.cost, historicalTotalCost: plan.total, performedById: actor.id,
        occurredAt: now, createdAt: now, justification: item.justification, notes: `Inventário ${record.id}: ${record.title}`,
        operationId, idempotencyKey: `inventory:${record.id}:${item.productId}`
      }, select: { id: true } });
      movementIds.push(movement.id);
      await tx.stockBalance.update({ where: { productId: item.productId }, data: { quantity: item.countedQuantity!, version: { increment: 1 } } });
      await tx.inventoryItem.update({ where: { inventoryId_productId: { inventoryId: targetId, productId: item.productId } }, data: { movementId: movement.id } });
      await tx.auditEvent.create({ data: {
        actorId: actor.id, action: "STOCK_ADJUSTMENT", module: "STOCK", entityType: "StockMovement", entityId: movement.id, operationId, origin: "inventory.complete",
        previousValues: { productId: item.productId, quantity: item.baselineQuantity.toFixed(4) },
        newValues: { inventoryId: targetId, productId: item.productId, quantityDelta: fixed(plan.delta, 4), quantity: item.countedQuantity!.toFixed(4), historicalUnitCost: plan.cost, historicalTotalCost: plan.total, justification: item.justification }
      } });
    }
    await tx.inventory.update({ where: { id: targetId }, data: { status: "COMPLETED", completedAt: now, completedById: actor.id, version: { increment: 1 } } });
    await audit(tx, actor, targetId, "COMPLETE", operationId, { status: "OPEN", version: record.version }, { title: record.title, status: "COMPLETED", version: record.version + 1, itemCount: plans.length, divergentItems: movementIds.length, movementIds });
    return finish(tx, actor, targetId, input.idempotencyKey, "COMPLETE", requestHash);
  });
}
export async function cancelInventory(actor: Principal, inventoryId: string, body: unknown): Promise<InventoryMutationResult> {
  const targetId = id(inventoryId);
  const input = inventoryActionSchema.parse(body);
  const permission = actor.permissions.includes("stock.adjust") ? "stock.adjust" : "stock.write";
  const requestHash = hash(actor, "CANCEL", targetId, { expectedVersion: input.expectedVersion });
  return write(actor, permission, async (tx) => {
    const previous = await replay(tx, actor, input.idempotencyKey, "CANCEL", requestHash);
    if (previous) return previous;
    const record = await locked(tx, targetId); editable(record, input.expectedVersion);
    if (permission !== "stock.adjust" && record.createdById !== actor.id) throw new ApplicationError("FORBIDDEN", "Somente o criador ou alguém com permissão de ajuste pode cancelar este inventário.");
    await tx.inventory.update({ where: { id: targetId }, data: { status: "CANCELED", canceledAt: new Date(), canceledById: actor.id, version: { increment: 1 } } });
    await audit(tx, actor, targetId, "CANCEL", randomUUID(), { status: "OPEN", version: record.version }, { status: "CANCELED", version: record.version + 1 });
    return finish(tx, actor, targetId, input.idempotencyKey, "CANCEL", requestHash);
  });
}
