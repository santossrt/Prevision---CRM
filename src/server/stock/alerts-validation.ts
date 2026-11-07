import { z } from "zod";
import { stockIdSchema } from "./validation.ts";

const integer = (fallback: number, max: number) => z.string().regex(/^[1-9]\d*$/)
  .transform(Number).pipe(z.number().int().max(max)).default(fallback);

export const stockAlertQuerySchema = z.object({
  kind: z.enum(["EMPTY", "LOW"]).optional(),
  search: z.string().trim().max(100).refine((value) => !value.includes("\0")).default(""),
  categoryId: stockIdSchema.optional(),
  page: integer(1, 1000000),
  pageSize: integer(20, 100)
}).strict();
