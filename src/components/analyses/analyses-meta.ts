import type { AnalysisFilters, ReplenishmentStatus } from "../../lib/analyses/types.ts";
import { dashboardToday, dashboardPreset, validDashboardDay, dashboardQuery, chartPosition } from "../dashboard/dashboard-meta.ts";

export { dashboardToday as analysisToday, dashboardFullDay as analysisDay, dashboardTimestamp as analysisTimestamp, dashboardProductHref as analysisProductHref, chartPosition } from "../dashboard/dashboard-meta.ts";
export interface AnalysisForm { from: string; to: string; search: string; status: string; thresholdA: string; thresholdB: string; horizonDays: string }
export const emptyAnalysisForm: AnalysisForm = { from: "", to: "", search: "", status: "all", thresholdA: "80.00", thresholdB: "95.00", horizonDays: "30" };
export function analysisPreset(now = new Date()): AnalysisForm { return { ...emptyAnalysisForm, ...dashboardPreset(90, now) }; }
function percent(value: string): string {
  if (!/^\d{1,2}(?:[.,]\d{1,2})?$/u.test(value.trim())) throw new Error("Informe os limites das classes com até duas casas decimais.");
  const [whole, fraction = ""] = value.trim().replace(",", ".").split(".");
  return `${BigInt(whole)}.${fraction.padEnd(2, "0")}`;
}
export function analysisFilters(form: AnalysisForm, now = new Date()): AnalysisFilters {
  if (!validDashboardDay(form.from) || !validDashboardDay(form.to) || form.from.startsWith("0000") || form.to.startsWith("0000")) throw new Error("Informe as duas datas do período.");
  dashboardQuery(form, now);
  const thresholdA = percent(form.thresholdA); const thresholdB = percent(form.thresholdB);
  const a = BigInt(thresholdA.replace(".", "")); const b = BigInt(thresholdB.replace(".", ""));
  if (a <= 0n || b >= 10000n || a >= b) throw new Error("Os limites devem seguir 0 < A < B < 100%.");
  if (!["all", "active", "inactive"].includes(form.status)) throw new Error("Escolha uma situação válida dos produtos.");
  if (!/^\d{1,3}$/u.test(form.horizonDays) || Number(form.horizonDays) < 1 || Number(form.horizonDays) > 365) throw new Error("Informe um horizonte de reposição entre 1 e 365 dias.");
  const search = form.search.trim();
  if (search.length > 100 || /[\u0000-\u001f\u007f]/u.test(search)) throw new Error("Informe uma pesquisa de até 100 caracteres.");
  return { from: form.from, to: form.to, search, status: form.status as AnalysisFilters["status"], thresholdA, thresholdB, horizonDays: Number(form.horizonDays) };
}
export function analysisQuery(filters: AnalysisFilters): string { return new URLSearchParams(analysisExportFilters(filters)).toString(); }
export function analysisExportFilters(filters: AnalysisFilters): Record<string, string> {
  return { from: filters.from, to: filters.to, search: filters.search, status: filters.status, thresholdA: filters.thresholdA, thresholdB: filters.thresholdB, horizonDays: String(filters.horizonDays) };
}
export function analysisInteger(value: string, decimals = 2): bigint {
  if (!/^\d+(?:\.\d+)?$/u.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 8) throw new Error("Valor de gráfico inválido.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error("Precisão de gráfico inválida.");
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}
export const statusLabels: Record<ReplenishmentStatus, string> = { INACTIVE: "Produto inativo", UNIT_CHANGED: "Unidade alterada", INSUFFICIENT_HISTORY: "Histórico insuficiente", NO_CONSUMPTION: "Sem consumo estimável", MISSING_LEAD_TIME: "Prazo não cadastrado", REORDER: "Atenção à reposição", OK: "Cobertura disponível" };
export const statusDescriptions: Record<ReplenishmentStatus, string> = {
  INACTIVE: "O produto está inativo; não há recomendação de compra.", UNIT_CHANGED: "A unidade mudou desde o início do período. Confira o histórico antes de estimar consumo.",
  INSUFFICIENT_HISTORY: "A estimativa exige ao menos 30 dias observados e dois dias com saídas líquidas positivas.", NO_CONSUMPTION: "O consumo líquido observado não permite estimar a cobertura.",
  MISSING_LEAD_TIME: "Cadastre o prazo no produto ou no fornecedor padrão para estimar o ponto e a quantidade de reposição.",
  REORDER: "A estimativa indica atenção à reposição a partir do saldo e dos parâmetros atuais.", OK: "A cobertura estimada ainda supera o ponto de reposição calculado."
};
export const noEstimate = "Sem estimativa";
