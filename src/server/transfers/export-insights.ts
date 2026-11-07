import "server-only";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { ReportFilters, TransferColumn } from "../../lib/transfers/types.ts";
import { replenishmentStatusLabels } from "../../lib/analyses/labels.ts";
import { loadAnalysisData } from "../analyses/data.ts";
import { parseAnalysisFilters } from "../analyses/validation.ts";
import { loadDashboardData } from "../dashboard/data.ts";
import { parseDashboardPeriod } from "../dashboard/validation.ts";

const columns = (fields: [string, string][]): TransferColumn[] => fields.map(([key, label]) => ({ key, label }));
type Row = Record<string, string | null>;
const abcColumns = columns([
  ["name", "Produto"], ["sku", "SKU"], ["unit", "Unidade atual"], ["active", "Ativo"],
  ["grossQuantity", "Saídas brutas"], ["reversedQuantity", "Saídas compensadas"], ["netQuantity", "Quantidade líquida"],
  ["grossCost", "Custo histórico bruto"], ["reversedCost", "Custo compensado"], ["cost", "Valor de consumo líquido"],
  ["share", "Participação (%)"], ["cumulative", "Acumulado (%)"], ["classification", "Classe ABC"], ["note", "Observação"]
]);
const replenishmentColumns = columns([
  ["name", "Produto"], ["sku", "SKU"], ["unit", "Unidade atual"], ["status", "Situação da estimativa"], ["quantity", "Saldo atual"],
  ["minimum", "Estoque mínimo"], ["safety", "Estoque de segurança"], ["minimumGap", "Falta para atingir o mínimo"], ["supplier", "Fornecedor padrão"],
  ["leadDays", "Prazo de entrega (dias)"], ["leadSource", "Origem do prazo"], ["observedDays", "Dias observados"], ["positiveDays", "Dias com saída líquida positiva"],
  ["netQuantity", "Saídas líquidas observadas"], ["average", "Consumo médio diário"], ["coverage", "Cobertura estimada (dias)"],
  ["reorderPoint", "Ponto de reposição"], ["recommended", "Quantidade sugerida"], ["stockoutDate", "Esgotamento estimado"], ["reorderDate", "Reposição estimada"], ["note", "Observação"]
]);

export async function loadInsightReport(tx: Prisma.TransactionClient, kind: "abc" | "replenishment" | "indicators", filters: ReportFilters) {
  if (kind === "indicators") {
    const data = await loadDashboardData(tx, parseDashboardPeriod(new URLSearchParams(filters)));
    const rows: Row[] = [];
    const add = (section: string, metric: string, value: string | number, unit: string, reference: string) => rows.push({ section, metric, value: String(value), unit, reference });
    const now = data.generatedAt; const period = `${data.period.from} a ${data.period.to}`;
    for (const [key, label] of [["products", "Produtos cadastrados"], ["activeProducts", "Produtos ativos"], ["inactiveProducts", "Produtos inativos"], ["lowStock", "Estoque baixo (ativos)"], ["emptyStock", "Sem estoque (ativos)"]] as const) add("Estoque atual", label, data.current[key], "produtos", now);
    for (const [key, label] of [["estimatedCost", "Custo estimado"], ["potentialSale", "Venda potencial"], ["estimatedMargin", "Margem estimada"]] as const) add("Estoque atual", label, data.current[key], "R$", now);
    for (const [key, label] of [["entries", "Entradas originais"], ["exits", "Saídas originais"], ["adjustments", "Ajustes"], ["compensations", "Compensações"]] as const) add("Movimentos no período", label, data.movements[key], "lançamentos", period);
    for (const [key, label] of [["entriesCost", "Custo histórico das entradas"], ["exitsCost", "Custo histórico das saídas"], ["exitsSale", "Venda histórica das saídas"]] as const) add("Movimentos no período", label, data.movements[key], "R$", period);
    for (const item of data.units) for (const [key, label] of [["entryQuantity", "Entradas brutas"], ["exitQuantity", "Saídas brutas"], ["adjustmentDelta", "Variação dos ajustes"], ["compensationDelta", "Variação das compensações"]] as const) add("Quantidades por unidade", label, item[key], item.unit, period);
    for (const point of data.series) {
      const reference = `${point.from} a ${point.to}`;
      add("Evolução por registro", "Custo estimado do estoque", point.estimatedStockCost, "R$", reference);
      add("Movimentos por operação", "Custo histórico das entradas", point.entriesCost, "R$", reference);
      add("Movimentos por operação", "Custo histórico das saídas", point.exitsCost, "R$", reference);
    }
    for (const item of data.mostMoved) add("Mais movimentados", `${item.name} (SKU ${item.sku})`, item.movements, "lançamentos", period);
    for (const item of data.highestValue) add("Maior valor atual", `${item.name} (SKU ${item.sku})${item.isActive ? "" : " — Inativo"}`, item.estimatedCost, "R$", now);
    for (const item of data.categories) { add("Categorias atuais", item.name, item.products, "produtos", now); add("Categorias atuais", item.name, item.estimatedCost, "R$", now); }
    return { title: "Indicadores do estoque", columns: columns([["section", "Seção"], ["metric", "Indicador"], ["value", "Valor"], ["unit", "Unidade"], ["reference", "Referência"]]), rows, warnings: [`Período e agrupamentos em America/Sao_Paulo. Posição consultada em ${data.generatedAt}.`, ...data.warnings] };
  }
  const data = await loadAnalysisData(tx, parseAnalysisFilters(new URLSearchParams(filters)));
  const criteria = `Período: ${data.filters.from} a ${data.filters.to}, America/Sao_Paulo. Posição atual: ${data.asOfDate}. Limites ABC: ${data.filters.thresholdA}% e ${data.filters.thresholdB}%. Horizonte de reposição: ${data.filters.horizonDays} dias. Histórico mínimo: ${data.criteria.minimumHistoryDays} dias e ${data.criteria.minimumPositiveExitDays} dias com saída líquida positiva.`;
  if (kind === "abc") {
    const rows: Row[] = data.abc.products.map((item) => ({ name: item.name, sku: item.sku, unit: item.unit, active: item.isActive ? "Sim" : "Não",
      grossQuantity: item.grossExitQuantity, reversedQuantity: item.reversedExitQuantity, netQuantity: item.netQuantity,
      grossCost: item.grossExitCost, reversedCost: item.reversedExitCost, cost: item.consumptionCost, share: item.share, cumulative: item.cumulativeShare,
      classification: item.classification ?? "Sem consumo financeiro",
      note: [item.unitChanged ? "Unidade alterada; não comparar quantidades históricas com a unidade atual." : "", item.clamped ? "Compensações excederam as saídas; valores líquidos negativos foram limitados a zero." : ""].filter(Boolean).join(" ") || null }));
    return { title: "Curva ABC por custo histórico de consumo", columns: abcColumns, rows, warnings: [criteria, ...data.warnings] };
  }
  const rows: Row[] = data.replenishment.products.map((item) => ({ name: item.name, sku: item.sku, unit: item.unit, status: replenishmentStatusLabels[item.status],
    quantity: item.quantity, minimum: item.minimumStock, safety: item.safetyStock, minimumGap: item.minimumGap,
    supplier: item.supplier ? `${item.supplier.name}${item.supplier.isActive ? "" : " (inativo)"}` : null,
    leadDays: item.leadTimeDays === null ? null : String(item.leadTimeDays), leadSource: item.leadTimeSource === "product" ? "Produto" : item.leadTimeSource === "supplier" ? "Fornecedor" : null,
    observedDays: String(item.observedDays), positiveDays: String(item.positiveExitDays), netQuantity: item.netExitQuantity,
    average: item.averageDaily, coverage: item.daysUntilStockout, reorderPoint: item.reorderPoint, recommended: item.recommendedQuantity,
    stockoutDate: item.estimatedStockoutDate, reorderDate: item.estimatedReorderDate,
    note: [item.dateLimited ? "Data fora do horizonte de 10 anos; consulte a cobertura numérica." : "", item.supplier?.isActive === false ? "Confirme o prazo com um fornecedor ativo." : ""].filter(Boolean).join(" ") || null }));
  return { title: "Estimativas de reposição do estoque", columns: replenishmentColumns, rows, warnings: [criteria, ...data.warnings] };
}
