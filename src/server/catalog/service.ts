import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import type { CategoryDTO, SupplierDTO, CustomerDTO, ProductDTO, ProductValueDTO, CatalogList, CatalogOptions } from "../../lib/catalog/types.ts";
import type { Principal } from "../auth/identity.ts";
import { lockAuthState } from "../auth/sessions.ts";
import { assertActorInTransaction, assertPermission } from "../authorization/guard.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import {
  catalogIdSchema, catalogListQuerySchema, productListQuerySchema, valueListQuerySchema, queryObject,
  categoryCreateSchema, categoryUpdateSchema, supplierCreateSchema, supplierUpdateSchema,
  customerCreateSchema, customerUpdateSchema, productCreateSchema, productUpdateSchema, normalizeCatalogDocument
} from "./validation.ts";

const productInclude = {
  category: { select: { id: true, name: true, isActive: true } },
  defaultSupplier: { select: { id: true, name: true, isActive: true } },
  stockBalance: { select: { quantity: true } }
} as const satisfies Prisma.ProductInclude;
const valueInclude = { changedBy: { select: { id: true, name: true } } } as const satisfies Prisma.ProductValueHistoryInclude;
type CategoryRecord = Prisma.CategoryGetPayload<{}>;
type SupplierRecord = Prisma.SupplierGetPayload<{}>;
type CustomerRecord = Prisma.CustomerGetPayload<{}>;
type ProductRecord = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type ValueRecord = Prisma.ProductValueHistoryGetPayload<{ include: typeof valueInclude }>;
type CatalogDTO = CategoryDTO | SupplierDTO | CustomerDTO | ProductDTO;
type CatalogModule = "CATEGORIES" | "SUPPLIERS" | "CUSTOMERS" | "PRODUCTS";
type ListQuery = z.output<typeof catalogListQuerySchema>;
type TableName = "categories" | "suppliers" | "customers" | "products";

function id(value: string) {
  const result = catalogIdSchema.safeParse(value);
  if (!result.success) throw new ApplicationError("VALIDATION", "Identificador de cadastro inválido.");
  return result.data;
}
function filters<S extends z.ZodType>(schema: S, query: URLSearchParams): z.output<S> {
  try { return schema.parse(queryObject(query)); }
  catch { throw new ApplicationError("VALIDATION", "Filtros inválidos. Confira a pesquisa e a paginação."); }
}
function base(record: CategoryRecord | SupplierRecord | CustomerRecord | ProductRecord) {
  return { id: record.id, name: record.name, isActive: record.isActive, version: record.version, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() };
}
const categoryDTO = (record: CategoryRecord): CategoryDTO => ({ ...base(record), description: record.description });
const customerDTO = (record: CustomerRecord): CustomerDTO => ({ ...base(record), taxId: record.taxId, email: record.email, phone: record.phone, address: record.address });
const supplierDTO = (record: SupplierRecord): SupplierDTO => ({ ...customerDTO(record), replenishmentLeadTimeDays: record.replenishmentLeadTimeDays });
function productDTO(record: ProductRecord): ProductDTO {
  if (!record.stockBalance) throw new ApplicationError("UNAVAILABLE", "O saldo inicial deste produto precisa ser verificado.");
  const quantity = record.stockBalance.quantity;
  return {
    ...base(record), sku: record.sku, barcode: record.barcode, description: record.description,
    categoryId: record.categoryId, defaultSupplierId: record.defaultSupplierId,
    category: record.category, defaultSupplier: record.defaultSupplier, unitOfMeasure: record.unitOfMeasure,
    quantity: quantity.toFixed(4), minimumStock: record.minimumStock.toFixed(4), safetyStock: record.safetyStock.toFixed(4),
    acquisitionCost: record.acquisitionCost.toFixed(4), salePrice: record.salePrice.toFixed(4),
    replenishmentLeadTimeDays: record.replenishmentLeadTimeDays,
    stockStatus: quantity.isZero() ? "empty" : quantity.lte(record.minimumStock) ? "low" : "normal"
  };
}
const valueDTO = (record: ValueRecord): ProductValueDTO => ({
  id: record.id, productId: record.productId, type: record.type, previousValue: record.previousValue?.toFixed(4) ?? null,
  newValue: record.newValue.toFixed(4), changedBy: record.changedBy, effectiveAt: record.effectiveAt.toISOString(), operationId: record.operationId
});
const stale = () => new ApplicationError("CONFLICT", "Este cadastro foi alterado por outra operação. Atualize a lista e tente novamente.");
const notFound = () => new ApplicationError("NOT_FOUND", "Cadastro não encontrado.");

function writeFailure(error: unknown, module: CatalogModule): never {
  if (error instanceof ApplicationError || error instanceof z.ZodError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      const target = JSON.stringify(error.meta?.target ?? "");
      const message = target.includes("sku") ? "Já existe um produto com esse SKU."
        : target.includes("barcode") ? "Já existe um produto com esse código de barras."
        : module === "CATEGORIES" ? "Já existe uma categoria com esse nome."
        : "Já existe um cadastro com esse documento ou código.";
      throw new ApplicationError("CONFLICT", message);
    }
    if (error.code === "P2003") throw new ApplicationError("CONFLICT", "Um cadastro relacionado não está mais disponível. Atualize a lista.");
    if (["P2025", "P2034", "P2028"].includes(error.code)) throw stale();
  }
  throw new ApplicationError("UNAVAILABLE", "Não foi possível salvar o cadastro. Tente novamente.");
}

async function read<T>(actor: Principal, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  assertPermission(actor, "catalog.read");
  await verifyDatabaseIdentity();
  return getDatabase().$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 15000 });
}
async function write<T>(actor: Principal, module: CatalogModule, work: (tx: Prisma.TransactionClient, operationId: string) => Promise<T>): Promise<T> {
  assertPermission(actor, "catalog.write");
  await verifyDatabaseIdentity();
  const operationId = randomUUID();
  try {
    return await getDatabase().$transaction(async (tx) => {
      // READ COMMITTED obtains fresh snapshots after waiting for authorization.
      await lockAuthState(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026103003)`;
      await assertActorInTransaction(tx, actor, "catalog.write");
      return work(tx, operationId);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 15000 });
  } catch (error) { return writeFailure(error, module); }
}

async function audit(tx: Prisma.TransactionClient, actor: Principal, module: CatalogModule, entityType: string, before: CatalogDTO | null, after: CatalogDTO, operationId: string) {
  // Only the public catalog allowlist is serialized; never pass Prisma users.
  const snapshot = (value: CatalogDTO) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
  await tx.auditEvent.create({ data: {
    actorId: actor.id, module, entityType, entityId: after.id, operationId,
    action: !before ? "CREATE" : before.isActive === after.isActive ? "UPDATE" : after.isActive ? "ACTIVATE" : "DEACTIVATE",
    ...(before ? { previousValues: snapshot(before) } : {}), newValues: snapshot(after), origin: "catalog"
  } });
}

function conditions(query: ListQuery, searchFields: readonly string[]) {
  const clauses: Prisma.Sql[] = [];
  if (query.status !== "all") clauses.push(Prisma.sql`p.is_active = ${query.status === "active"}`);
  if (query.search) {
    // Field names are fixed constants supplied by the service, never input.
    const terms = searchFields.flatMap((field) => {
      const term = field === "tax_id" ? normalizeCatalogDocument(query.search) : query.search;
      if (!term) return [];
      const pattern = `%${term.replace(/[!%_]/g, (character) => `!${character}`)}%`;
      return [Prisma.sql`${Prisma.raw(`p."${field}"`)} ILIKE ${pattern} ESCAPE '!'`];
    });
    clauses.push(Prisma.sql`(${Prisma.join(terms, " OR ")})`);
  }
  return clauses;
}
async function listIds(tx: Prisma.TransactionClient, table: TableName, query: ListQuery, fields: readonly string[], extra: Prisma.Sql[] = []) {
  const clauses = [...conditions(query, fields), ...extra];
  const where = clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}` : Prisma.empty;
  const source = table === "products"
    ? Prisma.sql`public.products p LEFT JOIN public.stock_balances b ON b.product_id = p.id`
    : Prisma.sql`${Prisma.raw(`public."${table}"`)} p`;
  const [count] = await tx.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM ${source} ${where}`;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT p.id FROM ${source} ${where} ORDER BY p.name ASC, p.id ASC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;
  return { ids: rows.map((row) => row.id), total: count.total };
}
function page<T extends { id: string }>(items: T[], result: { ids: string[]; total: number }, query: { page: number; pageSize: number }): CatalogList<T> {
  const byId = new Map(items.map((item) => [item.id, item]));
  return { items: result.ids.map((key) => byId.get(key)!).filter(Boolean), total: result.total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(result.total / query.pageSize) };
}

export async function listCategories(actor: Principal, search: URLSearchParams): Promise<CatalogList<CategoryDTO>> {
  assertPermission(actor, "catalog.read");
  const query = filters(catalogListQuerySchema, search);
  return read(actor, async (tx) => {
    const result = await listIds(tx, "categories", query, ["name", "description"]);
    return page((await tx.category.findMany({ where: { id: { in: result.ids } } })).map(categoryDTO), result, query);
  });
}
export async function listSuppliers(actor: Principal, search: URLSearchParams): Promise<CatalogList<SupplierDTO>> {
  assertPermission(actor, "catalog.read");
  const query = filters(catalogListQuerySchema, search);
  return read(actor, async (tx) => {
    const result = await listIds(tx, "suppliers", query, ["name", "tax_id", "email", "phone"]);
    return page((await tx.supplier.findMany({ where: { id: { in: result.ids } } })).map(supplierDTO), result, query);
  });
}
export async function listCustomers(actor: Principal, search: URLSearchParams): Promise<CatalogList<CustomerDTO>> {
  assertPermission(actor, "catalog.read");
  const query = filters(catalogListQuerySchema, search);
  return read(actor, async (tx) => {
    const result = await listIds(tx, "customers", query, ["name", "tax_id", "email", "phone"]);
    return page((await tx.customer.findMany({ where: { id: { in: result.ids } } })).map(customerDTO), result, query);
  });
}
export async function listProducts(actor: Principal, search: URLSearchParams): Promise<CatalogList<ProductDTO>> {
  assertPermission(actor, "catalog.read");
  const query = filters(productListQuerySchema, search);
  const extra: Prisma.Sql[] = [];
  if (query.categoryId) extra.push(Prisma.sql`p.category_id = ${query.categoryId}::uuid`);
  if (query.supplierId) extra.push(Prisma.sql`p.default_supplier_id = ${query.supplierId}::uuid`);
  if (query.stock === "empty") extra.push(Prisma.sql`b.quantity = 0`);
  if (query.stock === "low") extra.push(Prisma.sql`b.quantity > 0 AND b.quantity <= p.minimum_stock`);
  if (query.stock === "normal") extra.push(Prisma.sql`b.quantity > p.minimum_stock`);
  return read(actor, async (tx) => {
    const result = await listIds(tx, "products", query, ["name", "sku", "barcode"], extra);
    return page((await tx.product.findMany({ where: { id: { in: result.ids } }, include: productInclude })).map(productDTO), result, query);
  });
}

export async function getCategory(actor: Principal, key: string): Promise<CategoryDTO> {
  assertPermission(actor, "catalog.read"); const validId = id(key);
  return read(actor, async (tx) => { const item = await tx.category.findUnique({ where: { id: validId } }); if (!item) throw notFound(); return categoryDTO(item); });
}
export async function getSupplier(actor: Principal, key: string): Promise<SupplierDTO> {
  assertPermission(actor, "catalog.read"); const validId = id(key);
  return read(actor, async (tx) => { const item = await tx.supplier.findUnique({ where: { id: validId } }); if (!item) throw notFound(); return supplierDTO(item); });
}
export async function getCustomer(actor: Principal, key: string): Promise<CustomerDTO> {
  assertPermission(actor, "catalog.read"); const validId = id(key);
  return read(actor, async (tx) => { const item = await tx.customer.findUnique({ where: { id: validId } }); if (!item) throw notFound(); return customerDTO(item); });
}
export async function getProduct(actor: Principal, key: string): Promise<ProductDTO> {
  assertPermission(actor, "catalog.read"); const validId = id(key);
  return read(actor, async (tx) => { const item = await tx.product.findUnique({ where: { id: validId }, include: productInclude }); if (!item) throw notFound(); return productDTO(item); });
}

export async function createCategory(actor: Principal, input: unknown): Promise<CategoryDTO> {
  assertPermission(actor, "catalog.write"); const data = categoryCreateSchema.parse(input);
  return write(actor, "CATEGORIES", async (tx, operationId) => {
    const item = categoryDTO(await tx.category.create({ data }));
    await audit(tx, actor, "CATEGORIES", "Category", null, item, operationId); return item;
  });
}
export async function createSupplier(actor: Principal, input: unknown): Promise<SupplierDTO> {
  assertPermission(actor, "catalog.write"); const data = supplierCreateSchema.parse(input);
  return write(actor, "SUPPLIERS", async (tx, operationId) => {
    const item = supplierDTO(await tx.supplier.create({ data }));
    await audit(tx, actor, "SUPPLIERS", "Supplier", null, item, operationId); return item;
  });
}
export async function createCustomer(actor: Principal, input: unknown): Promise<CustomerDTO> {
  assertPermission(actor, "catalog.write"); const data = customerCreateSchema.parse(input);
  return write(actor, "CUSTOMERS", async (tx, operationId) => {
    const item = customerDTO(await tx.customer.create({ data }));
    await audit(tx, actor, "CUSTOMERS", "Customer", null, item, operationId); return item;
  });
}
export async function updateCategory(actor: Principal, key: string, input: unknown): Promise<CategoryDTO> {
  assertPermission(actor, "catalog.write"); const validId = id(key); const { expectedVersion, ...data } = categoryUpdateSchema.parse(input);
  return write(actor, "CATEGORIES", async (tx, operationId) => {
    const before = await tx.category.findUnique({ where: { id: validId } }); if (!before) throw notFound();
    if (before.version !== expectedVersion) throw stale();
    const updated = await tx.category.updateMany({ where: { id: validId, version: expectedVersion }, data: { ...data, version: { increment: 1 } } }); if (updated.count !== 1) throw stale();
    const item = categoryDTO((await tx.category.findUnique({ where: { id: validId } }))!);
    await audit(tx, actor, "CATEGORIES", "Category", categoryDTO(before), item, operationId); return item;
  });
}
export async function updateSupplier(actor: Principal, key: string, input: unknown): Promise<SupplierDTO> {
  assertPermission(actor, "catalog.write"); const validId = id(key); const { expectedVersion, ...data } = supplierUpdateSchema.parse(input);
  return write(actor, "SUPPLIERS", async (tx, operationId) => {
    const before = await tx.supplier.findUnique({ where: { id: validId } }); if (!before) throw notFound();
    if (before.version !== expectedVersion) throw stale();
    const updated = await tx.supplier.updateMany({ where: { id: validId, version: expectedVersion }, data: { ...data, version: { increment: 1 } } }); if (updated.count !== 1) throw stale();
    const item = supplierDTO((await tx.supplier.findUnique({ where: { id: validId } }))!);
    await audit(tx, actor, "SUPPLIERS", "Supplier", supplierDTO(before), item, operationId); return item;
  });
}
export async function updateCustomer(actor: Principal, key: string, input: unknown): Promise<CustomerDTO> {
  assertPermission(actor, "catalog.write"); const validId = id(key); const { expectedVersion, ...data } = customerUpdateSchema.parse(input);
  return write(actor, "CUSTOMERS", async (tx, operationId) => {
    const before = await tx.customer.findUnique({ where: { id: validId } }); if (!before) throw notFound();
    if (before.version !== expectedVersion) throw stale();
    const updated = await tx.customer.updateMany({ where: { id: validId, version: expectedVersion }, data: { ...data, version: { increment: 1 } } }); if (updated.count !== 1) throw stale();
    const item = customerDTO((await tx.customer.findUnique({ where: { id: validId } }))!);
    await audit(tx, actor, "CUSTOMERS", "Customer", customerDTO(before), item, operationId); return item;
  });
}

async function productReferences(tx: Prisma.TransactionClient, next: { categoryId: string; defaultSupplierId?: string | null; isActive?: boolean }, before?: ProductRecord) {
  const activating = Boolean(before && !before.isActive && next.isActive);
  const category = await tx.category.findUnique({ where: { id: next.categoryId }, select: { isActive: true } });
  if (!category || ((!before || activating || next.categoryId !== before.categoryId) && !category.isActive)) throw new ApplicationError("VALIDATION", "Selecione uma categoria ativa e disponível.");
  if (next.defaultSupplierId) {
    const supplier = await tx.supplier.findUnique({ where: { id: next.defaultSupplierId }, select: { isActive: true } });
    if (!supplier || ((!before || activating || next.defaultSupplierId !== before.defaultSupplierId) && !supplier.isActive)) throw new ApplicationError("VALIDATION", "Selecione um fornecedor ativo e disponível.");
  }
}
async function priceHistory(tx: Prisma.TransactionClient, actor: Principal, product: ProductRecord, before: ProductRecord | null, operationId: string) {
  const entries: Prisma.ProductValueHistoryCreateManyInput[] = [];
  if (!before || !before.acquisitionCost.equals(product.acquisitionCost)) entries.push({ productId: product.id, type: "ACQUISITION_COST", previousValue: before?.acquisitionCost ?? null, newValue: product.acquisitionCost, changedById: actor.id, operationId });
  if (!before || !before.salePrice.equals(product.salePrice)) entries.push({ productId: product.id, type: "SALE_PRICE", previousValue: before?.salePrice ?? null, newValue: product.salePrice, changedById: actor.id, operationId });
  if (entries.length) await tx.productValueHistory.createMany({ data: entries });
}
export async function createProduct(actor: Principal, input: unknown): Promise<ProductDTO> {
  assertPermission(actor, "catalog.write"); const data = productCreateSchema.parse(input);
  return write(actor, "PRODUCTS", (tx, operationId) => createProductInTransaction(tx, actor, data, operationId));
}
/** Shared by manual creation and an already-authorized atomic import. */
export async function createProductInTransaction(tx: Prisma.TransactionClient, actor: Principal, data: z.output<typeof productCreateSchema>, operationId: string): Promise<ProductDTO> {
  await productReferences(tx, data);
  const record = await tx.product.create({ data: { ...data, stockBalance: { create: { quantity: "0.0000" } } }, include: productInclude });
  await priceHistory(tx, actor, record, null, operationId);
  const item = productDTO(record); await audit(tx, actor, "PRODUCTS", "Product", null, item, operationId); return item;
}
export async function updateProduct(actor: Principal, key: string, input: unknown): Promise<ProductDTO> {
  assertPermission(actor, "catalog.write"); const validId = id(key); const { expectedVersion, ...data } = productUpdateSchema.parse(input);
  return write(actor, "PRODUCTS", async (tx, operationId) => {
    const before = await tx.product.findUnique({ where: { id: validId }, include: productInclude }); if (!before) throw notFound();
    if (before.version !== expectedVersion) throw stale();
    await productReferences(tx, { categoryId: data.categoryId ?? before.categoryId, defaultSupplierId: data.defaultSupplierId === undefined ? before.defaultSupplierId : data.defaultSupplierId, isActive: data.isActive ?? before.isActive }, before);
    const updated = await tx.product.updateMany({ where: { id: validId, version: expectedVersion }, data: { ...data, version: { increment: 1 } } }); if (updated.count !== 1) throw stale();
    const record = (await tx.product.findUnique({ where: { id: validId }, include: productInclude }))!;
    await priceHistory(tx, actor, record, before, operationId);
    const item = productDTO(record); await audit(tx, actor, "PRODUCTS", "Product", productDTO(before), item, operationId); return item;
  });
}

export async function listProductValues(actor: Principal, key: string, search: URLSearchParams): Promise<CatalogList<ProductValueDTO>> {
  assertPermission(actor, "catalog.read"); const validId = id(key); const query = filters(valueListQuerySchema, search);
  return read(actor, async (tx) => {
    if (!await tx.product.findUnique({ where: { id: validId }, select: { id: true } })) throw notFound();
    const total = await tx.productValueHistory.count({ where: { productId: validId } });
    const items = await tx.productValueHistory.findMany({ where: { productId: validId }, include: valueInclude, orderBy: [{ effectiveAt: "desc" }, { id: "desc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize });
    return { items: items.map(valueDTO), total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
  });
}
export async function getCatalogOptions(actor: Principal): Promise<CatalogOptions> {
  return read(actor, async (tx) => {
    const select = { id: true, name: true, isActive: true } as const;
    const categories = await tx.category.findMany({ select, orderBy: [{ name: "asc" }, { id: "asc" }] });
    const suppliers = await tx.supplier.findMany({ select, orderBy: [{ name: "asc" }, { id: "asc" }] });
    return { categories, suppliers };
  });
}
