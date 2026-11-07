import { z } from "zod";
import { catalogDecimalSchema } from "../catalog/validation.ts";

export const inventoryIdSchema = z.string().uuid().transform((value) => value.toLowerCase());
const cleanText = (max: number) => z.string().trim().max(max).refine((value) => !value.includes("\0"));
const optionalText = (max: number) => cleanText(max).transform((value) => value || null).nullable().optional();
const uniqueIds = (max: number) => z.array(inventoryIdSchema).min(1).max(max)
  .refine((values) => new Set(values).size === values.length, "Não repita produtos ou categorias.")
  .transform((values) => values.sort());
const create = { title: cleanText(160).min(1), notes: optionalText(2000), idempotencyKey: inventoryIdSchema };
export const inventoryCreateSchema = z.discriminatedUnion("scope", [
  z.object({ ...create, scope: z.literal("all") }).strict(),
  z.object({ ...create, scope: z.literal("products"), productIds: uniqueIds(200) }).strict(),
  z.object({ ...create, scope: z.literal("categories"), categoryIds: uniqueIds(200) }).strict()
]);
const action = { expectedVersion: z.number().int().nonnegative().max(2147483646), idempotencyKey: inventoryIdSchema };
export const inventoryActionSchema = z.object(action).strict();
export const inventoryRebaseSchema = z.object({ ...action, productIds: uniqueIds(200) }).strict();
export const inventoryCountsSchema = z.object({
  ...action,
  items: z.array(z.object({ productId: inventoryIdSchema, countedQuantity: catalogDecimalSchema, justification: optionalText(600) }).strict()).min(1).max(20)
    .refine((values) => new Set(values.map((value) => value.productId)).size === values.length, "Não repita o mesmo produto na contagem.")
    .transform((values) => values.sort((first, second) => first.productId.localeCompare(second.productId)))
}).strict();
const integer = (fallback: number, max: number) => z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(max)).default(fallback);
export const inventoryListSchema = z.object({
  search: cleanText(100).default(""), status: z.enum(["all", "OPEN", "COMPLETED", "CANCELED"]).default("all"),
  page: integer(1, 1000000), pageSize: integer(20, 100)
}).strict();
