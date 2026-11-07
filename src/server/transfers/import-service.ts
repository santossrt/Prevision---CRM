import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "../../generated/prisma/client.ts";
import type { ImportPreviewDTO, ImportPreviewRowDTO, ImportResult } from "../../lib/transfers/types.ts";
import type { Principal } from "../auth/identity.ts";
import { lockAuthState } from "../auth/sessions.ts";
import { assertActorInTransaction, assertPermission } from "../authorization/guard.ts";
import { createProductInTransaction } from "../catalog/service.ts";
import { catalogDecimalSchema, normalizeCatalogDocument, productCreateSchema } from "../catalog/validation.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { importColumns, type ImportColumn } from "./import-columns.ts";
import { parseImportFile, type ImportFormat, type ParsedImportRow } from "./import-parser.ts";
import { prepareTransferRetention, reserveTransferPayload } from "./retention.ts";

type Tx = Prisma.TransactionClient;
type Input = z.output<typeof productCreateSchema>;
type Ref = { id: string; version: number };
type StoredRow = ImportPreviewRowDTO & { input: Input | null; category: Ref | null; supplier: Ref | null };
type Payload = { version: 1; rows: StoredRow[] };
type Record = Prisma.ProductImportGetPayload<{}>;
const columns = { nome: "name", sku: "sku", codigo_barras: "barcode", categoria: "category", fornecedor: "supplier", documento_fornecedor: "supplierDocument", unidade: "unitOfMeasure", estoque_minimo: "minimumStock", custo_aquisicao: "acquisitionCost", preco_venda: "salePrice", estoque_seguranca: "safetyStock", prazo_reposicao_dias: "replenishmentLeadTimeDays", descricao: "description", ativo: "isActive" } as const;
export const importId = z.string().uuid().transform((value) => value.toLowerCase());
export const importConfirmSchema = z.object({ idempotencyKey: importId }).strict();
const notFound = () => new ApplicationError("NOT_FOUND", "Prévia de importação não encontrada.");
const stale = () => new ApplicationError("CONFLICT", "Os cadastros usados na prévia foram alterados ou um código já foi utilizado. Envie o arquivo novamente para conferir os dados atuais.");
export class ImportPreviewExpiredError extends ApplicationError {
  constructor() { super("CONFLICT", "A prévia de importação expirou. Envie o arquivo novamente antes de confirmar."); }
}
function permission(actor: Principal) { assertPermission(actor, "catalog.read"); assertPermission(actor, "catalog.write"); }
function dto(record: Record): ImportPreviewDTO {
  const payload = record.payload as unknown as Payload;
  const status = record.status === "COMPLETED" ? "COMPLETED" : record.expiresAt.getTime() <= Date.now() ? "EXPIRED" : "PREVIEW";
  return {
    id: record.id, fileName: record.fileName, format: record.format as ImportFormat, status,
    createdAt: record.createdAt.toISOString(), expiresAt: record.expiresAt.toISOString(), rowCount: record.rowCount,
    validCount: record.rowCount - record.errorCount, errorCount: record.errorCount, createdCount: record.createdCount,
    canConfirm: status === "PREVIEW" && record.errorCount === 0,
    columns: importColumns.map(([key, label]) => ({ key: columns[key], label })),
    rows: payload.rows.map((row) => ({ rowNumber: row.rowNumber, data: row.data, errors: row.errors })), operationId: record.operationId
  };
}
async function write<T>(actor: Principal, work: (tx: Tx) => Promise<T>): Promise<T> {
  permission(actor); await verifyDatabaseIdentity();
  try {
    return await getDatabase().$transaction(async (tx) => {
      await lockAuthState(tx); await tx.$executeRaw`SELECT pg_advisory_xact_lock(2026103003)`;
      await assertActorInTransaction(tx, actor, "catalog.read"); await assertActorInTransaction(tx, actor, "catalog.write");
      return work(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5000, timeout: 30000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2003", "P2025", "P2028", "P2034"].includes(error.code)) throw stale();
    throw error;
  }
}
const normalizedName = (value: string) => value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("pt-BR");
const decimal = (value: string | undefined) => value?.trim() ? value.trim().replace(",", ".") : undefined;

async function validateRows(tx: Tx, parsed: ParsedImportRow[]): Promise<StoredRow[]> {
  const [categories, suppliers, products] = await Promise.all([
    tx.category.findMany({ select: { id: true, name: true, isActive: true, version: true } }),
    tx.supplier.findMany({ select: { id: true, name: true, taxId: true, isActive: true, version: true } }),
    tx.product.findMany({ where: { OR: [{ sku: { in: parsed.map((row) => row.values.sku?.trim().toUpperCase() ?? "") } }, { barcode: { in: parsed.map((row) => row.values.codigo_barras?.trim() ?? "").filter(Boolean) } }] }, select: { sku: true, barcode: true } })
  ]);
  const existingSkus = new Set(products.map((item) => item.sku)); const existingBarcodes = new Set(products.map((item) => item.barcode).filter(Boolean));
  const rows: StoredRow[] = parsed.map((row) => {
    const values = row.values; const errors = row.issues.map((issue) => ({ ...issue, ...(issue.column ? { column: columns[issue.column as ImportColumn] } : {}) }));
    const data = Object.fromEntries(importColumns.map(([key]) => [columns[key], (values[key] ?? "").slice(0, key === "descricao" ? 4000 : 512)]));
    const category = categories.find((item) => normalizedName(item.name) === normalizedName(values.categoria ?? "") && item.isActive);
    if (!category) errors.push({ column: "category", message: "Informe uma categoria ativa já cadastrada." });
    const supplierName = normalizedName(values.fornecedor ?? ""); const document = normalizeCatalogDocument(values.documento_fornecedor ?? "");
    const matches = suppliers.filter((item) => item.isActive && (document ? item.taxId === document : supplierName && normalizedName(item.name) === supplierName));
    const supplier = supplierName || document ? matches.length === 1 ? matches[0] : null : undefined;
    if (supplierName || document) {
      if (!supplier || supplierName && normalizedName(supplier.name) !== supplierName) errors.push({ column: "supplier", message: "Fornecedor não encontrado, inativo ou ambíguo. Confira o nome e informe o documento para distinguir cadastros." });
    }
    const active = (values.ativo ?? "").trim().toLocaleLowerCase("pt-BR");
    if (active && !["sim", "não", "nao", "true", "false", "1", "0"].includes(active)) errors.push({ column: "isActive", message: "Informe Sim ou Não no campo Ativo." });
    const lead = values.prazo_reposicao_dias?.trim();
    const source = {
      name: values.nome ?? "", sku: values.sku ?? "", barcode: values.codigo_barras || null,
      categoryId: category?.id ?? "00000000-0000-4000-8000-000000000000", defaultSupplierId: supplier?.id ?? null,
      ...(values.unidade ? { unitOfMeasure: values.unidade } : {}), description: values.descricao || null,
      ...(decimal(values.estoque_minimo) ? { minimumStock: decimal(values.estoque_minimo) } : {}),
      ...(decimal(values.custo_aquisicao) ? { acquisitionCost: decimal(values.custo_aquisicao) } : {}),
      ...(decimal(values.preco_venda) ? { salePrice: decimal(values.preco_venda) } : {}),
      ...(decimal(values.estoque_seguranca) ? { safetyStock: decimal(values.estoque_seguranca) } : {}),
      replenishmentLeadTimeDays: lead ? /^\d+$/u.test(lead) ? Number(lead) : -1 : null,
      isActive: !["não", "nao", "false", "0"].includes(active)
    };
    const result = productCreateSchema.safeParse(source);
    if (!result.success) for (const issue of result.error.issues) errors.push({ column: String(issue.path[0] ?? ""), message: issue.message });
    const input = result.success ? result.data : null;
    if (input) {
      Object.assign(data, { name: input.name, sku: input.sku, barcode: input.barcode ?? "", category: category?.name ?? data.category, supplier: supplier?.name ?? "", unitOfMeasure: input.unitOfMeasure, minimumStock: input.minimumStock, acquisitionCost: input.acquisitionCost, salePrice: input.salePrice, safetyStock: input.safetyStock, isActive: input.isActive ? "Sim" : "Não" });
      if (existingSkus.has(input.sku)) errors.push({ column: "sku", message: "O SKU já está cadastrado, inclusive entre produtos inativos." });
      if (input.barcode && existingBarcodes.has(input.barcode)) errors.push({ column: "barcode", message: "O código de barras já está cadastrado, inclusive entre produtos inativos." });
    }
    return { rowNumber: row.rowNumber, data, errors, input, category: category ? { id: category.id, version: category.version } : null, supplier: supplier ? { id: supplier.id, version: supplier.version } : null };
  });
  for (const field of ["sku", "barcode"] as const) {
    const groups = new Map<string, StoredRow[]>();
    for (const row of rows) { const value = row.input?.[field]; if (value) groups.set(value, [...groups.get(value) ?? [], row]); }
    for (const group of groups.values()) if (group.length > 1) for (const row of group) row.errors.push({ column: field, message: field === "sku" ? "O SKU aparece mais de uma vez neste arquivo." : "O código de barras aparece mais de uma vez neste arquivo." });
  }
  return rows;
}

export async function previewProductImport(actor: Principal, fileName: string, buffer: Buffer, format: ImportFormat): Promise<ImportPreviewDTO> {
  permission(actor);
  const parsed = await parseImportFile(buffer, format);
  const canonical = parsed.map((row) => Object.fromEntries(importColumns.map(([key]) => {
    let value = row.values[key]?.trim() ?? "";
    if (key === "sku" || key === "unidade") value = value.toUpperCase();
    if (key === "categoria" || key === "fornecedor") value = normalizedName(value);
    if (key === "documento_fornecedor") value = normalizeCatalogDocument(value);
    if (["estoque_minimo", "custo_aquisicao", "preco_venda", "estoque_seguranca"].includes(key)) {
      const number = catalogDecimalSchema.safeParse(decimal(value) ?? "0"); if (number.success) value = number.data;
    }
    if (key === "ativo") value = ["não", "nao", "false", "0"].includes(value.toLocaleLowerCase("pt-BR")) ? "false" : value === "" || ["sim", "true", "1"].includes(value.toLocaleLowerCase("pt-BR")) ? "true" : value;
    if (key === "unidade" && !value) value = "UN";
    return [key, value];
  }))).sort((first, second) => JSON.stringify(first).localeCompare(JSON.stringify(second)));
  const dataHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  await prepareTransferRetention(actor, ["catalog.read", "catalog.write"]);
  return write(actor, async (tx) => {
    const completed = await tx.productImport.findFirst({ where: { ownerId: actor.id, dataHash, status: "COMPLETED" }, orderBy: { createdAt: "desc" } });
    if (completed) return dto(completed);
    const rows = await validateRows(tx, parsed); const now = new Date(); const operationId = randomUUID();
    const payload = JSON.parse(JSON.stringify({ version: 1, rows })) as Prisma.InputJsonObject;
    await reserveTransferPayload(tx, actor.id, payload);
    const record = await tx.productImport.create({ data: {
      ownerId: actor.id, fileName, format, dataHash, payload,
      rowCount: rows.length, errorCount: rows.filter((row) => row.errors.length).length, createdAt: now, expiresAt: new Date(now.getTime() + 30 * 60 * 1000), operationId
    } });
    await tx.auditEvent.create({ data: { actorId: actor.id, module: "TRANSFERS", action: "CREATE", entityType: "ProductImport", entityId: record.id, operationId, origin: "transfers.import.preview", newValues: { fileName, format, rowCount: record.rowCount, errorCount: record.errorCount, status: "PREVIEW" } } });
    return dto(record);
  });
}
export async function getProductImport(actor: Principal, key: string): Promise<ImportPreviewDTO> {
  permission(actor); const validId = importId.parse(key); await verifyDatabaseIdentity();
  return getDatabase().$transaction(async (tx) => {
    await assertActorInTransaction(tx, actor, "catalog.read"); await assertActorInTransaction(tx, actor, "catalog.write");
    const record = await tx.productImport.findFirst({ where: { id: validId, ownerId: actor.id } }); if (!record) throw notFound();
    if (record.status !== "COMPLETED" && record.expiresAt.getTime() <= Date.now()) throw new ImportPreviewExpiredError();
    return dto(record);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 15000 });
}
export async function confirmProductImport(actor: Principal, key: string, body: unknown): Promise<ImportResult> {
  permission(actor); const validId = importId.parse(key); const input = importConfirmSchema.parse(body);
  return write(actor, async (tx) => {
    const records = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM product_imports WHERE id=${validId}::uuid AND owner_id=${actor.id}::uuid FOR UPDATE`;
    if (!records.length) throw notFound();
    const record = (await tx.productImport.findUnique({ where: { id: validId } }))!;
    if (record.status === "COMPLETED") return { import: dto(record), replayed: true };
    const alreadyCompleted = await tx.productImport.findFirst({ where: { ownerId: actor.id, dataHash: record.dataHash, status: "COMPLETED" } });
    if (alreadyCompleted) return { import: dto(alreadyCompleted), replayed: true };
    if (record.expiresAt.getTime() <= Date.now()) throw new ImportPreviewExpiredError();
    if (record.errorCount) throw new ApplicationError("VALIDATION", "Corrija as linhas com erro e envie o arquivo novamente. Nenhum produto foi criado.");
    const payload = record.payload as unknown as Payload;
    for (const row of payload.rows) {
      if (!row.input || row.errors.length || !row.category) throw new ApplicationError("VALIDATION", "A prévia contém erros. Envie o arquivo novamente.");
      const category = await tx.category.findUnique({ where: { id: row.category.id }, select: { isActive: true, version: true } });
      if (!category?.isActive || category.version !== row.category.version) throw stale();
      if (row.supplier) { const supplier = await tx.supplier.findUnique({ where: { id: row.supplier.id }, select: { isActive: true, version: true } }); if (!supplier?.isActive || supplier.version !== row.supplier.version) throw stale(); }
    }
    for (const row of payload.rows) await createProductInTransaction(tx, actor, productCreateSchema.parse(row.input), record.operationId);
    const completed = await tx.productImport.update({ where: { id: record.id }, data: { status: "COMPLETED", createdCount: record.rowCount, completedAt: new Date(), confirmationKey: input.idempotencyKey } });
    await tx.auditEvent.create({ data: { actorId: actor.id, module: "TRANSFERS", action: "IMPORT", entityType: "ProductImport", entityId: record.id, operationId: record.operationId, origin: "transfers.import.complete", newValues: { fileName: record.fileName, format: record.format, rowCount: record.rowCount, createdCount: record.rowCount, status: "COMPLETED" } } });
    return { import: dto(completed), replayed: false };
  });
}
