import { z } from "zod";
import type { DashboardPeriod } from "../../lib/dashboard/types.ts";
import { ApplicationError } from "../errors/application-error.ts";

export const dashboardTimeZone = "America/Sao_Paulo" as const;
const dayMilliseconds = 86400000;
const dateSchema = z.iso.date().refine((value) => value.slice(0, 4) !== "0000");
const querySchema = z.object({ from: dateSchema.optional(), to: dateSchema.optional() }).strict();
const dateNumber = (value: string) => Date.parse(`${value}T00:00:00Z`);
export const addCalendarDays = (value: string, days: number) => new Date(dateNumber(value) + days * dayMilliseconds).toISOString().slice(0, 10);
export function dashboardToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: dashboardTimeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function parseDashboardPeriod(search: URLSearchParams, now = new Date()): DashboardPeriod {
  const values: Record<string, string> = {};
  for (const [key, value] of search) {
    if (Object.hasOwn(values, key)) throw new ApplicationError("VALIDATION", "Não repita os filtros do painel.");
    Object.defineProperty(values, key, { value, enumerable: true });
  }
  const result = querySchema.safeParse(values);
  if (!result.success || Boolean(result.data?.from) !== Boolean(result.data?.to)) throw new ApplicationError("VALIDATION", "Informe as duas datas do período no formato dia, mês e ano.");
  const today = dashboardToday(now);
  const from = result.data.from ?? addCalendarDays(today, -29);
  const to = result.data.to ?? today;
  const days = (dateNumber(to) - dateNumber(from)) / dayMilliseconds + 1;
  if (from > to || to > today || days > 366) throw new ApplicationError("VALIDATION", "Escolha um período de até 366 dias, com início antes do fim e sem datas futuras.");
  return { from, to, granularity: days <= 31 ? "day" : "month", timeZone: dashboardTimeZone };
}

export function dashboardBuckets(period: DashboardPeriod): { from: string; to: string }[] {
  const result: { from: string; to: string }[] = [];
  let from = period.from;
  while (from <= period.to) {
    if (period.granularity === "day") {
      result.push({ from, to: from });
      from = addCalendarDays(from, 1);
    } else {
      const date = new Date(`${from}T00:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() + 1, 1);
      const next = date.toISOString().slice(0, 10);
      const monthEnd = addCalendarDays(next, -1);
      result.push({ from, to: monthEnd < period.to ? monthEnd : period.to });
      from = next;
    }
  }
  return result;
}
