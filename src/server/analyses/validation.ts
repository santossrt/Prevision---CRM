import { z } from "zod";
import type { AnalysisFilters } from "../../lib/analyses/types.ts";
import { addCalendarDays, dashboardToday } from "../dashboard/validation.ts";
import { ApplicationError } from "../errors/application-error.ts";

export const analysisTimeZone = "America/Sao_Paulo" as const;
const day = z.iso.date().refine((value) => value.slice(0, 4) !== "0000");
const percentage = z.string().regex(/^\d{1,2}(?:\.\d{1,2})?$/u).transform((value) => {
  const [whole, fraction = ""] = value.split(".");
  return `${BigInt(whole)}.${fraction.padEnd(2, "0")}`;
});
const query = z.object({
  from: day.optional(), to: day.optional(),
  search: z.string().trim().max(100).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)).default(""),
  status: z.enum(["all", "active", "inactive"]).default("all"),
  thresholdA: percentage.default("80.00"), thresholdB: percentage.default("95.00"),
  horizonDays: z.coerce.number().int().min(1).max(365).default(30)
}).strict();

export const analysisPeriodDays = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 + 1;
export const percentHundredths = (value: string) => BigInt(value.replace(".", ""));

export function parseAnalysisFilters(search: URLSearchParams, now = new Date()): AnalysisFilters {
  const values: Record<string, string> = {};
  for (const [key, value] of search) {
    if (Object.hasOwn(values, key)) throw new ApplicationError("VALIDATION", "Não repita os filtros das análises.");
    Object.defineProperty(values, key, { value, enumerable: true });
  }
  const result = query.safeParse(values);
  if (!result.success || Boolean(result.data?.from) !== Boolean(result.data?.to)) throw new ApplicationError("VALIDATION", "Confira o período e os critérios das análises.");
  const today = dashboardToday(now);
  const from = result.data.from ?? addCalendarDays(today, -89);
  const to = result.data.to ?? today;
  if (from > to || to > today || analysisPeriodDays(from, to) > 366) throw new ApplicationError("VALIDATION", "Escolha um período de até 366 dias, sem datas futuras e com início antes do fim.");
  const thresholdA = percentHundredths(result.data.thresholdA); const thresholdB = percentHundredths(result.data.thresholdB);
  if (thresholdA <= 0n || thresholdA >= thresholdB || thresholdB >= 10000n) throw new ApplicationError("VALIDATION", "Os limites da Curva ABC devem respeitar 0 < A < B < 100%.");
  return { ...result.data, from, to };
}
