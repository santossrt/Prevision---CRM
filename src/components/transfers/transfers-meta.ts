import type { ReportKind } from "@/lib/transfers/types";
import { canExportReport } from "@/lib/transfers/access";
export const reportLabels: Record<ReportKind, string> = {
  products: "Produtos cadastrados", stock: "Estoque atual", low_stock: "Produtos com estoque baixo", empty_stock: "Produtos sem estoque",
  entries: "Entradas", exits: "Saídas", adjustments: "Ajustes de estoque", movements: "Histórico de movimentações", inventories: "Inventários", audit: "Auditoria",
  abc: "Curva ABC", replenishment: "Previsão de reposição", indicators: "Indicadores do estoque"
};
export function allowedReports(permissions: readonly string[]): ReportKind[] {
  return (Object.keys(reportLabels) as ReportKind[]).filter((kind) => canExportReport(permissions, kind));
}
export const filterLabels: Record<string, string> = {
  search: "Pesquisa", status: "Situação", categoryId: "Categoria", supplierId: "Fornecedor", stock: "Estoque", productId: "Produto (ID)", type: "Tipo", from: "De", to: "Até",
  actorId: "Responsável", module: "Módulo", action: "Ação", entityType: "Tipo de registro", entityId: "Registro (ID)", operationId: "Operação (ID)",
  thresholdA: "Limite da classe A (%)", thresholdB: "Limite acumulado da classe B (%)", horizonDays: "Horizonte de reposição (dias)"
};
export const statusLabels: Record<string, string> = { all: "Todos", active: "Ativos", inactive: "Inativos", OPEN: "Abertos", COMPLETED: "Concluídos", CANCELED: "Cancelados", normal: "Acima do mínimo", low: "Estoque baixo", empty: "Sem estoque" };
export function periodFilters(from: string, to: string): Record<string, string> {
  if (from && to && from > to) throw new Error("A data inicial deve ser anterior ou igual à data final.");
  const result: Record<string, string> = {};
  for (const [key, value, suffix] of [["from", from, "T00:00:00"], ["to", to, "T23:59:59.999"]]) {
    if (!value) continue;
    const date = new Date(value + suffix);
    if (Number.isNaN(date.getTime())) throw new Error("Informe um período válido.");
    result[key] = date.toISOString();
  }
  return result;
}

export interface ReportForm {
  search: string; productStatus: string; categoryId: string; supplierId: string; stock: string;
  productId: string; type: string; inventoryStatus: string; inventoryId: string; from: string; to: string;
  actorId: string; module: string; action: string; entityType: string; entityId: string; operationId: string;
  thresholdA: string; thresholdB: string; horizonDays: string;
}
export const initialReportForm: ReportForm = {
  search: "", productStatus: "all", categoryId: "", supplierId: "", stock: "all", productId: "", type: "",
  inventoryStatus: "all", inventoryId: "", from: "", to: "", actorId: "", module: "", action: "", entityType: "", entityId: "", operationId: "",
  thresholdA: "80.00", thresholdB: "95.00", horizonDays: "30"
};
export function buildReportFilters(kind: ReportKind, form: ReportForm): Record<string, string> {
  const result: Record<string, string> = {};
  if (kind === "abc" || kind === "replenishment" || kind === "indicators") {
    if (Boolean(form.from) !== Boolean(form.to)) throw new Error("Informe as duas datas do período.");
    if (form.from && form.to && form.from > form.to) throw new Error("A data inicial deve ser anterior ou igual à data final.");
    if (form.from) { result.from = form.from; result.to = form.to; }
    if (kind !== "indicators") {
      if (form.search.trim()) result.search = form.search.trim();
      result.status = form.productStatus;
      result.thresholdA = form.thresholdA.trim().replace(",", "."); result.thresholdB = form.thresholdB.trim().replace(",", "."); result.horizonDays = form.horizonDays.trim();
    }
    return result;
  }
  const add = (key: keyof ReportForm, target: string = key) => { const value = form[key].trim(); if (value) result[target] = value; };
  add("search");
  if (["products", "stock", "low_stock", "empty_stock"].includes(kind)) {
    if (form.productStatus !== "all") add("productStatus", "status");
    add("categoryId"); add("supplierId");
    if ((kind === "products" || kind === "stock") && form.stock !== "all") add("stock");
  } else {
    Object.assign(result, periodFilters(form.from, form.to));
    if (kind === "inventories") { if (form.inventoryStatus !== "all") add("inventoryStatus", "status"); add("inventoryId"); }
    else if (kind === "audit") for (const field of ["actorId", "module", "action", "entityType", "entityId", "operationId"] as const) add(field);
    else { add("productId"); if (kind === "movements") add("type"); }
  }
  return result;
}
