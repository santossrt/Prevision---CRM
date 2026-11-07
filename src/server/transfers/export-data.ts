import "server-only";
import { Prisma } from "../../generated/prisma/client.ts";
import type { ReportFilters, ReportKind, TransferColumn } from "../../lib/transfers/types.ts";
import { actionLabel, moduleLabel } from "../../lib/audit/labels.ts";
import { sanitizeAuditOrigin, sanitizeAuditSnapshot } from "../audit/sanitize.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { formatAuditReportSnapshot } from "./export-audit.ts";
import { loadInsightReport } from "./export-insights.ts";

type Row = Record<string, string | null>;
export interface ReportData { title: string; columns: TransferColumn[]; rows: Row[]; warnings: string[] }
const columns = (fields: [string, string][]) => fields.map(([key, label]) => ({ key, label }));
const where = (clauses: Prisma.Sql[]) => clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}` : Prisma.empty;
const pattern = (search: string) => `%${search.replace(/[!%_]/g, (character) => `!${character}`)}%`;
const utcTimestamp = (field: Prisma.Sql) => Prisma.sql`to_char(${field} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
function period(clauses: Prisma.Sql[], field: Prisma.Sql, query: ReportFilters) {
  if (query.from) clauses.push(Prisma.sql`${field} >= ${new Date(query.from)}::timestamptz`);
  if (query.to) clauses.push(Prisma.sql`${field} <= ${new Date(query.to)}::timestamptz`);
}
function productConditions(query: ReportFilters, stock?: string) {
  const clauses: Prisma.Sql[] = [];
  if (query.status !== "all") clauses.push(Prisma.sql`p.is_active = ${query.status === "active"}`);
  if (query.categoryId) clauses.push(Prisma.sql`p.category_id = ${query.categoryId}::uuid`);
  if (query.supplierId) clauses.push(Prisma.sql`p.default_supplier_id = ${query.supplierId}::uuid`);
  const state = stock ?? query.stock;
  if (state === "empty") clauses.push(Prisma.sql`b.quantity = 0`);
  if (state === "low") clauses.push(Prisma.sql`b.quantity > 0 AND b.quantity <= p.minimum_stock`);
  if (state === "normal") clauses.push(Prisma.sql`b.quantity > p.minimum_stock`);
  if (query.search) {
    const value = pattern(query.search);
    clauses.push(Prisma.sql`(p.name ILIKE ${value} ESCAPE '!' OR p.sku ILIKE ${value} ESCAPE '!' OR p.barcode ILIKE ${value} ESCAPE '!')`);
  }
  return clauses;
}
const productColumns = columns([
  ["name", "Produto"], ["sku", "SKU"], ["barcode", "Código de barras"], ["category", "Categoria"], ["supplier", "Fornecedor padrão"],
  ["unit", "Unidade"], ["quantity", "Saldo"], ["minimum", "Estoque mínimo"], ["cost", "Custo unitário"], ["price", "Preço unitário"],
  ["safety", "Estoque de segurança"], ["leadTime", "Reposição (dias)"], ["active", "Ativo"], ["description", "Descrição"]
]);
const stockColumns = columns([
  ["name", "Produto"], ["sku", "SKU"], ["barcode", "Código de barras"], ["category", "Categoria"], ["unit", "Unidade"], ["quantity", "Saldo"],
  ["minimum", "Estoque mínimo"], ["state", "Situação do estoque"], ["cost", "Custo unitário atual"], ["price", "Preço unitário atual"],
  ["estimatedCost", "Custo estimado do saldo"], ["potentialSale", "Venda potencial do saldo"], ["estimatedMargin", "Margem estimada"], ["active", "Ativo"]
]);

async function products(tx: Prisma.TransactionClient, kind: ReportKind, filters: ReportFilters): Promise<ReportData> {
  const clauses = productConditions(filters, kind === "low_stock" ? "low" : kind === "empty_stock" ? "empty" : undefined);
  const records = await tx.$queryRaw<Row[]>`SELECT p.name, p.sku, p.barcode, c.name AS category, s.name AS supplier,
    p.unit_of_measure AS unit, b.quantity::text AS quantity, p.minimum_stock::text AS minimum,
    p.acquisition_cost::text AS cost, p.sale_price::text AS price, p.safety_stock::text AS safety,
    p.replenishment_lead_time_days::text AS "leadTime", CASE WHEN p.is_active THEN 'Sim' ELSE 'Não' END AS active,
    p.description, CASE WHEN b.quantity = 0 THEN 'Sem estoque' WHEN b.quantity <= p.minimum_stock THEN 'Estoque baixo' ELSE 'Acima do mínimo' END AS state,
    round(b.quantity * p.acquisition_cost, 2)::text AS "estimatedCost", round(b.quantity * p.sale_price, 2)::text AS "potentialSale",
    (round(b.quantity * p.sale_price, 2) - round(b.quantity * p.acquisition_cost, 2))::text AS "estimatedMargin"
    FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN suppliers s ON s.id = p.default_supplier_id
    LEFT JOIN stock_balances b ON b.product_id = p.id ${where(clauses)} ORDER BY p.name ASC, p.id ASC LIMIT 1001`;
  if (records.some((record) => record.quantity === null)) throw new ApplicationError("UNAVAILABLE", "O saldo inicial de um produto precisa ser verificado antes de exportar.");
  const catalog = kind === "products";
  const allowed = catalog ? productColumns : stockColumns;
  return {
    title: catalog ? "Produtos cadastrados" : kind === "low_stock" ? "Produtos com estoque baixo" : kind === "empty_stock" ? "Produtos sem estoque" : "Estoque atual",
    columns: allowed, rows: records.map((record) => Object.fromEntries(allowed.map(({ key }) => [key, record[key] ?? null]))),
    warnings: catalog ? [] : ["Custo, venda potencial e margem do saldo são estimativas pelos valores atuais do cadastro; não representam lucro realizado ou custo médio contábil."]
  };
}

const movementColumns = columns([
  ["occurredAt", "Data da operação"], ["registeredAt", "Data do registro"], ["name", "Produto"], ["sku", "SKU"], ["type", "Tipo"], ["unit", "Unidade"],
  ["delta", "Variação"], ["before", "Saldo anterior"], ["after", "Saldo resultante"], ["unitCost", "Custo unitário histórico"], ["totalCost", "Custo total histórico"],
  ["unitPrice", "Preço unitário histórico"], ["totalPrice", "Venda total histórica"], ["supplier", "Fornecedor"], ["customer", "Cliente"], ["actor", "Responsável"],
  ["justification", "Justificativa"], ["notes", "Observações"], ["operationId", "Operação (ID)"], ["id", "Movimentação (ID)"], ["compensatesId", "Movimentação compensada (ID)"]
]);
async function movements(tx: Prisma.TransactionClient, kind: ReportKind, filters: ReportFilters): Promise<ReportData> {
  const clauses: Prisma.Sql[] = [];
  if (filters.productId) clauses.push(Prisma.sql`m.product_id = ${filters.productId}::uuid`);
  if (kind === "entries") clauses.push(Prisma.sql`m.type = 'ENTRY'`);
  else if (kind === "exits") clauses.push(Prisma.sql`m.type = 'EXIT'`);
  else if (kind === "adjustments") clauses.push(Prisma.sql`m.type IN ('POSITIVE_ADJUSTMENT','NEGATIVE_ADJUSTMENT','COMPENSATION')`);
  else if (filters.type) clauses.push(Prisma.sql`m.type = ${filters.type}::"StockMovementType"`);
  period(clauses, Prisma.sql`m.occurred_at`, filters);
  if (filters.search) {
    const value = pattern(filters.search);
    clauses.push(Prisma.sql`(p.name ILIKE ${value} ESCAPE '!' OR p.sku ILIKE ${value} ESCAPE '!' OR p.barcode ILIKE ${value} ESCAPE '!')`);
  }
  const rows = await tx.$queryRaw<Row[]>`SELECT m.id::text, ${utcTimestamp(Prisma.sql`m.occurred_at`)} AS "occurredAt", ${utcTimestamp(Prisma.sql`m.created_at`)} AS "registeredAt", p.name, p.sku,
    CASE m.type WHEN 'ENTRY' THEN 'Entrada' WHEN 'EXIT' THEN 'Saída' WHEN 'POSITIVE_ADJUSTMENT' THEN 'Ajuste positivo' WHEN 'NEGATIVE_ADJUSTMENT' THEN 'Ajuste negativo' ELSE 'Compensação' END AS type,
    p.unit_of_measure AS unit, m.quantity_delta::text AS delta, m.quantity_before::text AS before, m.quantity_after::text AS after,
    m.historical_unit_cost::text AS "unitCost", m.historical_total_cost::text AS "totalCost", m.historical_unit_price::text AS "unitPrice",
    m.historical_total_price::text AS "totalPrice", s.name AS supplier, c.name AS customer, u.name AS actor, m.justification, m.notes,
    m.operation_id::text AS "operationId", m.compensates_movement_id::text AS "compensatesId"
    FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN users u ON u.id = m.performed_by_id
    LEFT JOIN suppliers s ON s.id = m.supplier_id LEFT JOIN customers c ON c.id = m.customer_id
    ${where(clauses)} ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1001`;
  return { title: kind === "entries" ? "Entradas de estoque" : kind === "exits" ? "Saídas de estoque" : kind === "adjustments" ? "Ajustes e compensações" : "Histórico de movimentações", columns: movementColumns, rows, warnings: ["O período considera a data da operação. Custos e preços são os valores históricos do lançamento."] };
}

const inventoryColumns = columns([
  ["id", "Inventário (ID)"], ["title", "Inventário"], ["status", "Situação"], ["openedAt", "Aberto em"], ["completedAt", "Concluído em"], ["canceledAt", "Cancelado em"],
  ["createdBy", "Responsável pela abertura"], ["completedBy", "Responsável pela conclusão"], ["name", "Produto conferido"], ["sku", "SKU na abertura"], ["unit", "Unidade na abertura"],
  ["baseline", "Saldo de referência"], ["counted", "Quantidade física"], ["difference", "Diferença"], ["justification", "Justificativa"], ["countedBy", "Responsável pela contagem"], ["countedAt", "Contado em"], ["movementId", "Ajuste (ID)"]
]);
async function inventories(tx: Prisma.TransactionClient, filters: ReportFilters): Promise<ReportData> {
  const clauses: Prisma.Sql[] = [];
  if (filters.status !== "all") clauses.push(Prisma.sql`i.status = ${filters.status}::"InventoryStatus"`);
  if (filters.inventoryId) clauses.push(Prisma.sql`i.id = ${filters.inventoryId}::uuid`);
  if (filters.search) clauses.push(Prisma.sql`i.title ILIKE ${pattern(filters.search)} ESCAPE '!'`);
  period(clauses, Prisma.sql`i.opened_at`, filters);
  const rows = await tx.$queryRaw<Row[]>`SELECT i.id::text, i.title,
    CASE i.status WHEN 'OPEN' THEN 'Aberto' WHEN 'COMPLETED' THEN 'Concluído' ELSE 'Cancelado' END AS status,
    ${utcTimestamp(Prisma.sql`i.opened_at`)} AS "openedAt", ${utcTimestamp(Prisma.sql`i.completed_at`)} AS "completedAt", ${utcTimestamp(Prisma.sql`i.canceled_at`)} AS "canceledAt", u.name AS "createdBy", c.name AS "completedBy",
    t.name, t.sku, t.unit_of_measure AS unit, t.baseline_quantity::text AS baseline, t.counted_quantity::text AS counted,
    (t.counted_quantity - t.baseline_quantity)::text AS difference, t.justification, b.name AS "countedBy", ${utcTimestamp(Prisma.sql`t.counted_at`)} AS "countedAt", t.movement_id::text AS "movementId"
    FROM inventories i JOIN inventory_items t ON t.inventory_id = i.id JOIN users u ON u.id = i.created_by_id
    LEFT JOIN users c ON c.id = i.completed_by_id LEFT JOIN users b ON b.id = t.counted_by_id ${where(clauses)}
    ORDER BY i.opened_at DESC, i.id DESC, t.name ASC, t.product_id ASC LIMIT 1001`;
  return { title: "Inventários físicos — itens conferidos", columns: inventoryColumns, rows, warnings: ["Cada linha representa um produto de um inventário. O período considera a abertura da conferência; referências e contagens são históricas."] };
}

const auditColumns = columns([
  ["createdAt", "Data do registro"], ["actor", "Responsável"], ["action", "Ação"], ["module", "Módulo"], ["entityType", "Entidade"], ["entityId", "Entidade (ID)"],
  ["origin", "Origem"], ["operationId", "Operação (ID)"], ["previous", "Valores anteriores"], ["next", "Valores registrados"]
]);
async function audit(tx: Prisma.TransactionClient, filters: ReportFilters): Promise<ReportData> {
  const clauses: Prisma.Sql[] = [];
  if (filters.actorId) clauses.push(Prisma.sql`a.actor_id = ${filters.actorId}::uuid`);
  if (filters.module) clauses.push(Prisma.sql`a.module = ${filters.module}::"AuditModule"`);
  if (filters.action) clauses.push(Prisma.sql`a.action = ${filters.action}::"AuditAction"`);
  if (filters.entityType) clauses.push(Prisma.sql`a.entity_type = ${filters.entityType}`);
  if (filters.entityId) clauses.push(Prisma.sql`a.entity_id = ${filters.entityId}`);
  if (filters.operationId) clauses.push(Prisma.sql`a.operation_id = ${filters.operationId}::uuid`);
  period(clauses, Prisma.sql`a.created_at`, filters);
  if (filters.search) {
    const value = pattern(filters.search);
    clauses.push(Prisma.sql`(a.entity_type ILIKE ${value} ESCAPE '!' OR a.entity_id ILIKE ${value} ESCAPE '!' OR a.operation_id::text ILIKE ${value} ESCAPE '!' OR u.name ILIKE ${value} ESCAPE '!')`);
  }
  const records = await tx.$queryRaw<{ createdAt: string; actor: string | null; action: string; module: string; entityType: string; entityId: string | null; origin: string | null; operationId: string; previous: unknown; next: unknown }[]>`SELECT ${utcTimestamp(Prisma.sql`a.created_at`)} AS "createdAt", u.name AS actor,
    a.action::text, a.module::text, a.entity_type AS "entityType", a.entity_id AS "entityId", a.origin, a.operation_id::text AS "operationId",
    a.previous_values AS previous, a.new_values AS next FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id ${where(clauses)} ORDER BY a.created_at DESC, a.id DESC LIMIT 1001`;
  let shortened = false;
  const safe = (value: unknown) => {
    const formatted = formatAuditReportSnapshot(sanitizeAuditSnapshot(value));
    shortened ||= formatted.limited;
    return formatted.text;
  };
  const rows: Row[] = records.map((record) => ({ createdAt: record.createdAt, actor: record.actor, action: actionLabel(record.action), module: moduleLabel(record.module), entityType: record.entityType, entityId: record.entityId, origin: sanitizeAuditOrigin(record.origin), operationId: record.operationId, previous: safe(record.previous), next: safe(record.next) }));
  return { title: "Auditoria de atividades", columns: auditColumns, rows, warnings: ["Os valores anteriores e registrados incluem somente os campos disponíveis para consulta. Credenciais e campos desconhecidos são omitidos.", ...(shortened ? ["A exibição de alguns valores foi limitada nesta prévia, com até 4.000 caracteres por seção; consulte os detalhes da atividade na auditoria."] : [])] };
}

export async function loadReportData(tx: Prisma.TransactionClient, kind: ReportKind, filters: ReportFilters): Promise<ReportData> {
  const result = kind === "abc" || kind === "replenishment" || kind === "indicators" ? await loadInsightReport(tx, kind, filters)
    : kind === "products" || kind === "stock" || kind === "low_stock" || kind === "empty_stock" ? await products(tx, kind, filters)
    : kind === "inventories" ? await inventories(tx, filters) : kind === "audit" ? await audit(tx, filters) : await movements(tx, kind, filters);
  if (result.rows.length > 1000) throw new ApplicationError("VALIDATION", "O relatório ultrapassa 1.000 linhas. Refine os filtros ou divida o período.");
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new ApplicationError("VALIDATION", "O conteúdo do relatório é muito grande. Refine os filtros ou divida o período.");
  return result;
}
