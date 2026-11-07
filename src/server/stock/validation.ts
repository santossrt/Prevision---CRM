import { z } from "zod";
import { catalogDecimalSchema } from "../catalog/validation.ts";
import { ApplicationError } from "../errors/application-error.ts";

export const stockIdSchema = z.string().uuid().transform((value) => value.toLowerCase());
const text = (max: number) => z.string().trim().max(max).refine((value) => !value.includes("\0"));
const nullableText = (max: number) => text(max).transform((value) => value || null).nullable().optional();
const optionalId = stockIdSchema.nullable().optional();
const positiveQuantity = catalogDecimalSchema.refine((value) => value !== "0.0000", "Informe uma quantidade maior que zero.");
export const movementDateSchema = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const common = {
  productId: stockIdSchema, quantity: positiveQuantity, occurredAt: movementDateSchema,
  notes: nullableText(4000), idempotencyKey: stockIdSchema
};
export const movementCreateSchema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("ENTRY"), unitCost: catalogDecimalSchema, supplierId: stockIdSchema }).strict(),
  z.object({ ...common, type: z.literal("EXIT"), unitPrice: catalogDecimalSchema, customerId: optionalId }).strict(),
  z.object({ ...common, type: z.literal("POSITIVE_ADJUSTMENT"), justification: text(4000).min(1) }).strict(),
  z.object({ ...common, type: z.literal("NEGATIVE_ADJUSTMENT"), justification: text(4000).min(1) }).strict()
]);
export const compensationCreateSchema = z.object({ justification: text(4000).min(1), idempotencyKey: stockIdSchema }).strict();
const integer = (fallback: number, max: number) => z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(max)).default(fallback);
const pagination = { page: integer(1, 1000000), pageSize: integer(20, 100) };
export const balanceQuerySchema = z.object({
  ...pagination, search: text(100).default(""), status: z.enum(["all", "active", "inactive"]).default("all"),
  categoryId: stockIdSchema.optional(), stock: z.enum(["all", "empty", "low", "normal"]).default("all")
}).strict();
export const movementQuerySchema = z.object({
  ...pagination, search: text(100).default(""), productId: stockIdSchema.optional(),
  type: z.enum(["ENTRY", "EXIT", "POSITIVE_ADJUSTMENT", "NEGATIVE_ADJUSTMENT", "COMPENSATION"]).optional(),
  from: movementDateSchema.optional(), to: movementDateSchema.optional()
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, "Confira o período informado.");

export function parseStockQuery<S extends z.ZodType>(schema: S, search: URLSearchParams): z.output<S> {
  try {
    const object: Record<string, string> = Object.create(null);
    const seen = new Set<string>();
    for (const [key, value] of search) {
      if (seen.has(key)) throw new Error("duplicate-stock-filter");
      seen.add(key);
      if (value !== "") object[key] = value;
    }
    return schema.parse(object);
  } catch { throw new ApplicationError("VALIDATION", "Filtros inválidos. Confira a pesquisa, o período e a paginação."); }
}
