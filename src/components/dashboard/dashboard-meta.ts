export interface DashboardFilter { from: string; to: string }
const dayMs = 86400000;

export function validDashboardDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function dashboardToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function dashboardPreset(days: 30 | 90 | 365, now = new Date()): DashboardFilter {
  const to = dashboardToday(now);
  const start = new Date(`${to}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { from: start.toISOString().slice(0, 10), to };
}

export function dashboardQuery(filter: DashboardFilter, now = new Date()): string {
  if (!filter.from && !filter.to) return "";
  if (!validDashboardDay(filter.from) || !validDashboardDay(filter.to)) throw new Error("Informe as duas datas do período.");
  if (filter.from > filter.to) throw new Error("A data inicial deve ser anterior ou igual à final.");
  if (filter.to > dashboardToday(now)) throw new Error("O período deve terminar até a data de hoje em Brasília.");
  if ((Date.parse(`${filter.to}T00:00:00Z`) - Date.parse(`${filter.from}T00:00:00Z`)) / dayMs + 1 > 366) throw new Error("Selecione um período de até 366 dias.");
  return new URLSearchParams({ from: filter.from, to: filter.to }).toString();
}

/** Calendar labels never convert a midnight date into the browser's timezone. */
export function dashboardDayLabel(value: string, month = false): string {
  if (!validDashboardDay(value)) return "Data indisponível";
  const [year, part, day] = value.split("-");
  return month ? `${part}/${year}` : `${day}/${part}`;
}
export function dashboardFullDay(value: string): string {
  return validDashboardDay(value) ? value.split("-").reverse().join("/") : "Data indisponível";
}
export function dashboardTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(date) : "Data indisponível";
}

export function chartInteger(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,4})?$/u.test(value)) throw new Error("Valor de gráfico inválido.");
  const negative = value.startsWith("-");
  const [integer, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  return BigInt(integer + fraction.padEnd(4, "0")) * (negative ? -1n : 1n);
}
/** Only the viewbox coordinate is approximate; labels keep the original decimal. */
export function chartPosition(value: bigint, maximum: bigint, extent = 100): number {
  if (!Number.isSafeInteger(extent) || extent < 0 || extent > 10000) throw new Error("Escala de gráfico inválida.");
  if (maximum <= 0n || value <= 0n) return 0;
  const limited = value > maximum ? maximum : value;
  return Number(limited * BigInt(extent * 100) / maximum) / 100;
}
export const dashboardProductHref = (id: string): string | null => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id) ? `/estoque?productId=${id}` : null;
