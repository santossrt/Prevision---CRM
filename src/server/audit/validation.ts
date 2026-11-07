import { z } from "zod";
import { AuditAction, AuditModule } from "../../generated/prisma/enums.ts";
import { ApplicationError } from "../errors/application-error.ts";

export const auditIdSchema = z.string().uuid().transform((value) => value.toLowerCase());
const text = (max: number) => z.string().trim().max(max).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const page = (fallback: number, max: number) => z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(max)).default(fallback);
const date = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
export const auditQuerySchema = z.object({
  search: text(100).default(""), actorId: auditIdSchema.optional(), module: z.enum(AuditModule).optional(), action: z.enum(AuditAction).optional(),
  entityType: text(80).min(1).optional(), entityId: text(128).min(1).optional(), operationId: auditIdSchema.optional(),
  from: date.optional(), to: date.optional(), page: page(1, 1000000), pageSize: page(20, 100)
}).strict().refine((query) => !query.from || !query.to || query.from <= query.to, "Confira o período informado.");

export function parseAuditQuery(search: URLSearchParams) {
  const values: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  try {
    for (const [key, value] of search) {
      if (seen.has(key)) throw new Error("duplicate-audit-filter");
      seen.add(key);
      if (value !== "") values[key] = value;
    }
    return auditQuerySchema.parse(values);
  } catch { throw new ApplicationError("VALIDATION", "Filtros inválidos. Confira o período, os identificadores e a paginação."); }
}
