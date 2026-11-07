import "server-only";
import type { AbcProduct, AnalysisDTO, AnalysisFilters, ReplenishmentProduct } from "../../lib/analyses/types.ts";
import { addCalendarDays } from "../dashboard/validation.ts";
import { fixed } from "../stock/calculations.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { analysisPeriodDays, analysisTimeZone, percentHundredths } from "./validation.ts";

export interface AnalysisProductSource {
  id: string; name: string; sku: string; unit: string; isActive: boolean; unitChanged: boolean;
  quantity: string | null; minimumStock: string; safetyStock: string; invalidBalance: boolean;
  supplier: { id: string; name: string; isActive: boolean } | null;
  leadTimeDays: number | null; leadTimeSource: "product" | "supplier" | null;
  observedDays: number; positiveExitDays: number;
  grossExitQuantity: string; reversedExitQuantity: string; grossExitCost: string; reversedExitCost: string;
  forecastExitQuantity: string; forecastReversedExitQuantity: string;
}
const invalid = () => new ApplicationError("UNAVAILABLE", "O saldo ou o histórico precisa ser conferido antes de apresentar as análises.");
export function analysisScaled(value: string, places: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match || (match[2] ?? "").slice(places).replace(/0/gu, "")) throw invalid();
  return BigInt(match[1] + (match[2] ?? "").slice(0, places).padEnd(places, "0"));
}
const nonnegative = (value: bigint) => value > 0n ? value : 0n;
const maximum = (left: bigint, right: bigint) => left > right ? left : right;
const ceiling = (numerator: bigint, denominator: bigint) => (numerator + denominator - 1n) / denominator;
const rounded = (numerator: bigint, denominator: bigint) => (2n * numerator + denominator) / (2n * denominator);
const share = (value: bigint, total: bigint) => fixed(total === 0n ? 0n : rounded(value * 10000n, total), 2);

function abc(source: AnalysisProductSource[], filters: AnalysisFilters): AnalysisDTO["abc"] {
  const ordered = source.map((row) => {
    const quantity = analysisScaled(row.grossExitQuantity, 4) - analysisScaled(row.reversedExitQuantity, 4);
    const cost = analysisScaled(row.grossExitCost, 2) - analysisScaled(row.reversedExitCost, 2);
    return { row, quantity, cost: nonnegative(cost), clamped: quantity < 0n || cost < 0n };
  }).sort((left, right) => left.cost === right.cost ? left.row.name.localeCompare(right.row.name, "pt-BR") || left.row.id.localeCompare(right.row.id) : left.cost > right.cost ? -1 : 1);
  const total = ordered.reduce((sum, item) => sum + item.cost, 0n);
  let cumulative = 0n; let groupBefore = 0n; let previousCost: bigint | null = null;
  const products: AbcProduct[] = ordered.map(({ row, quantity, cost, clamped }) => {
    if (previousCost !== cost) { groupBefore = cumulative; previousCost = cost; }
    const classification = cost === 0n || total === 0n ? null : groupBefore * 10000n < total * percentHundredths(filters.thresholdA) ? "A" : groupBefore * 10000n < total * percentHundredths(filters.thresholdB) ? "B" : "C";
    cumulative += cost;
    return {
      id: row.id, name: row.name, sku: row.sku, unit: row.unit, isActive: row.isActive, unitChanged: row.unitChanged,
      grossExitQuantity: fixed(analysisScaled(row.grossExitQuantity, 4), 4), reversedExitQuantity: fixed(analysisScaled(row.reversedExitQuantity, 4), 4),
      netQuantity: row.unitChanged ? null : fixed(nonnegative(quantity), 4),
      grossExitCost: fixed(analysisScaled(row.grossExitCost, 2), 2), reversedExitCost: fixed(analysisScaled(row.reversedExitCost, 2), 2),
      consumptionCost: fixed(cost, 2), clamped, share: share(cost, total), cumulativeShare: share(cumulative, total), classification
    };
  });
  const classes = (["A", "B", "C", null] as const).map((classification) => {
    const items = products.filter((product) => product.classification === classification);
    const cost = items.reduce((sum, product) => sum + analysisScaled(product.consumptionCost, 2), 0n);
    return { classification, products: items.length, consumptionCost: fixed(cost, 2), share: share(cost, total) };
  });
  return { products, classes, totalConsumptionCost: fixed(total, 2) };
}

export function replenishmentProduct(row: AnalysisProductSource, filters: AnalysisFilters, asOfDate: string): ReplenishmentProduct {
  if (row.quantity === null || row.invalidBalance || !Number.isInteger(row.observedDays) || row.observedDays < 0 || row.observedDays > 366
    || !Number.isInteger(row.positiveExitDays) || row.positiveExitDays < 0 || row.positiveExitDays > row.observedDays
    || row.leadTimeDays !== null && (!Number.isSafeInteger(row.leadTimeDays) || row.leadTimeDays < 0)) throw invalid();
  const quantity = analysisScaled(row.quantity, 4); const minimum = analysisScaled(row.minimumStock, 4); const safety = analysisScaled(row.safetyStock, 4);
  const consumption = nonnegative(analysisScaled(row.forecastExitQuantity, 4) - analysisScaled(row.forecastReversedExitQuantity, 4));
  const result: ReplenishmentProduct = {
    id: row.id, name: row.name, sku: row.sku, unit: row.unit, isActive: row.isActive,
    quantity: fixed(quantity, 4), minimumStock: fixed(minimum, 4), safetyStock: fixed(safety, 4), minimumGap: fixed(nonnegative(minimum - quantity), 4),
    supplier: row.supplier, leadTimeDays: row.leadTimeDays, leadTimeSource: row.leadTimeSource,
    observedDays: row.observedDays, positiveExitDays: row.positiveExitDays, netExitQuantity: row.unitChanged ? null : fixed(consumption, 4),
    averageDaily: null, daysUntilStockout: null, reorderPoint: null, recommendedQuantity: null,
    estimatedStockoutDate: null, estimatedReorderDate: null, dateLimited: false, status: "INSUFFICIENT_HISTORY"
  };
  if (!row.isActive) return { ...result, status: "INACTIVE" };
  if (row.unitChanged) return { ...result, status: "UNIT_CHANGED" };
  if (row.observedDays < 30) return result;
  if (consumption === 0n) return { ...result, status: "NO_CONSUMPTION" };
  if (row.positiveExitDays < 2) return result;
  const days = BigInt(row.observedDays);
  result.averageDaily = fixed(rounded(consumption * 10000n, days), 8);
  result.daysUntilStockout = fixed(quantity * days * 100n / consumption, 2);
  const boundedDate = (offset: bigint): string | null => {
    if (offset > 3650n) { result.dateLimited = true; return null; }
    return addCalendarDays(asOfDate, Number(offset));
  };
  result.estimatedStockoutDate = boundedDate(quantity * days / consumption);
  if (row.leadTimeDays === null) return { ...result, status: "MISSING_LEAD_TIME" };
  const lead = BigInt(row.leadTimeDays);
  const pointNumerator = maximum(minimum * days, safety * days + consumption * lead);
  result.reorderPoint = fixed(ceiling(pointNumerator, days), 4);
  const targetNumerator = maximum(minimum * days, safety * days + consumption * (lead + BigInt(filters.horizonDays)));
  result.recommendedQuantity = fixed(ceiling(nonnegative(targetNumerator - quantity * days), days), 4);
  const daysToReorder = nonnegative(quantity * days - pointNumerator) / consumption;
  result.estimatedReorderDate = boundedDate(daysToReorder);
  result.status = daysToReorder === 0n ? "REORDER" : "OK";
  return result;
}

export const analysisWarnings = [
  "A Curva ABC usa o custo histórico líquido das saídas no período. Compensações de saídas são descontadas pela data da compensação, inclusive quando o original pertence a outro período; ajustes e entradas não são consumo.",
  "Saldos líquidos negativos de quantidade ou custo são limitados a zero e identificados na linha. Saídas com custo líquido zero ficam sem classe financeira, em vez de receber classe C.",
  "A classe usa o acumulado antes do grupo: o produto que atravessa um limite permanece na faixa em que começou. Valores financeiros iguais recebem a mesma classe; os limites são aproximados e alguma classe pode ficar vazia.",
  "Percentuais são arredondados somente para exibição. A classificação utiliza valores exatos e considera todo o conjunto filtrado, inclusive produtos inativos quando selecionados.",
  "A reposição é uma estimativa estatística, não uma garantia. Exige pelo menos 30 dias observados e consumo líquido positivo em dois dias distintos; dias sem consumo também entram na média. O período observado começa no cadastro do produto, quando posterior ao início selecionado.",
  "Média diária = saídas líquidas observadas ÷ dias observados. Cobertura = saldo atual ÷ média diária. As datas partem do dia atual em America/Sao_Paulo; estimativas além de 3.650 dias não recebem uma data.",
  "Prazo do produto tem prioridade, inclusive zero; se ausente, usa o fornecedor padrão. Sem prazo, não há recomendação de compra ou data de reposição. Confirme o prazo de fornecedores inativos antes de planejar uma compra.",
  "Ponto de reposição = maior entre mínimo e segurança + média × prazo. Estoque-alvo = maior entre mínimo e segurança + média × (prazo + horizonte). Quantidade sugerida = alvo − saldo atual, limitada a zero e arredondada para cima em quatro casas.",
  "Saldo e parâmetros são os atuais. Produtos inativos não recebem previsão de compra. Uma alteração de unidade desde o início do período impede estimar quantidades e reposição; os custos históricos continuam disponíveis para a Curva ABC."
];

export function buildAnalysis(source: AnalysisProductSource[], filters: AnalysisFilters, generatedAt: string, asOfDate: string): AnalysisDTO {
  if (source.length > 1000) throw new ApplicationError("VALIDATION", "A análise ultrapassa 1.000 produtos. Refine a pesquisa ou a situação para analisar o conjunto completo.");
  const products = source.map((row) => replenishmentProduct(row, filters, asOfDate));
  return {
    generatedAt, asOfDate, filters,
    criteria: { timeZone: analysisTimeZone, periodDays: analysisPeriodDays(filters.from, filters.to), minimumHistoryDays: 30, minimumPositiveExitDays: 2, dateLimitDays: 3650 },
    abc: abc(source, filters),
    replenishment: { products, reorderCount: products.filter((product) => product.status === "REORDER").length, insufficientCount: products.filter((product) => ["INSUFFICIENT_HISTORY", "NO_CONSUMPTION", "MISSING_LEAD_TIME", "UNIT_CHANGED"].includes(product.status)).length },
    warnings: [...analysisWarnings]
  };
}
