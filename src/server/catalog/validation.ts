import { z } from "zod";

const cleanText = (maximum: number) => z.string().trim().max(maximum).refine((value) => !value.includes("\0"));
const name = (maximum: number) => cleanText(maximum).transform((value) => value.replace(/\s+/gu, " ")).pipe(z.string().min(1).max(maximum));
const nullableText = (maximum: number) => cleanText(maximum).transform((value) => value || null).nullable().optional();
export const catalogIdSchema = z.string().uuid();
const optionalId = z.preprocess((value) => value === "" ? null : value, catalogIdSchema.nullable().optional());
const version = z.number().int().nonnegative().max(2_147_483_646);
const leadTime = z.number().int().min(0).max(3650).nullable().optional();
export const normalizeCatalogDocument = (value: string) => value.replace(/[\s./-]/gu, "").toUpperCase();

/** Decimal(18,4) is validated and canonicalized without IEEE-754 conversion. */
export const catalogDecimalSchema = cleanText(64)
  .regex(/^\d+(?:\.\d{1,4})?$/, "Use um valor não negativo com até quatro casas decimais.")
  .refine((value) => value.split(".")[0].replace(/^0+/u, "").length <= 14, "O valor ultrapassa o limite permitido.")
  .transform((value) => {
    const [integer, fraction = ""] = value.split(".");
    return `${integer.replace(/^0+(?=\d)/u, "")}.${fraction.padEnd(4, "0")}`;
  });

const categoryFields = {
  name: name(100), description: nullableText(4000), isActive: z.boolean().optional()
};
const partyFields = {
  name: name(160),
  taxId: cleanText(64).transform(normalizeCatalogDocument)
    .pipe(z.string().max(32).regex(/^[A-Z0-9]*$/)).transform((value) => value || null).nullable().optional(),
  email: cleanText(254).toLowerCase().transform((value) => value || null)
    .pipe(z.email().nullable()).nullable().optional(),
  phone: nullableText(32), address: nullableText(4000), isActive: z.boolean().optional()
};
const productFields = {
  name: name(160),
  sku: cleanText(64).toUpperCase().pipe(z.string().min(1).max(64).refine((value) => !/\s/u.test(value), "O SKU não pode conter espaços.")),
  barcode: cleanText(128).transform((value) => value || null)
    .pipe(z.string().regex(/^[^\s\u0000-\u001f\u007f]+$/u).nullable()).nullable().optional(),
  description: nullableText(4000), categoryId: catalogIdSchema, defaultSupplierId: optionalId,
  unitOfMeasure: cleanText(20).toUpperCase().pipe(z.string().min(1).max(20)),
  minimumStock: catalogDecimalSchema, safetyStock: catalogDecimalSchema,
  acquisitionCost: catalogDecimalSchema, salePrice: catalogDecimalSchema,
  replenishmentLeadTimeDays: leadTime, isActive: z.boolean().optional()
};
const hasChanges = (value: Record<string, unknown>) => Object.entries(value).some(([key, item]) => key !== "expectedVersion" && item !== undefined);

export const categoryCreateSchema = z.object(categoryFields).strict();
export const categoryUpdateSchema = z.object(categoryFields).partial().extend({ expectedVersion: version }).strict().refine(hasChanges, "Informe uma alteração.");
export const customerCreateSchema = z.object(partyFields).strict();
export const customerUpdateSchema = z.object(partyFields).partial().extend({ expectedVersion: version }).strict().refine(hasChanges, "Informe uma alteração.");
export const supplierCreateSchema = z.object({ ...partyFields, replenishmentLeadTimeDays: leadTime }).strict();
export const supplierUpdateSchema = z.object({ ...partyFields, replenishmentLeadTimeDays: leadTime }).partial().extend({ expectedVersion: version }).strict().refine(hasChanges, "Informe uma alteração.");
export const productCreateSchema = z.object({
  ...productFields, unitOfMeasure: productFields.unitOfMeasure.default("UN"),
  minimumStock: catalogDecimalSchema.default("0.0000"), safetyStock: catalogDecimalSchema.default("0.0000"),
  acquisitionCost: catalogDecimalSchema.default("0.0000"), salePrice: catalogDecimalSchema.default("0.0000")
}).strict();
export const productUpdateSchema = z.object(productFields).partial().extend({ expectedVersion: version }).strict().refine(hasChanges, "Informe uma alteração.");

const integerQuery = (fallback: number, maximum: number) => z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().max(maximum)).default(fallback);
const baseQueryFields = {
  search: cleanText(100).default(""),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  page: integerQuery(1, 1000000), pageSize: integerQuery(20, 100)
};
export const catalogListQuerySchema = z.object(baseQueryFields).strict();
export const productListQuerySchema = z.object({
  ...baseQueryFields, categoryId: catalogIdSchema.optional(), supplierId: catalogIdSchema.optional(),
  stock: z.enum(["all", "normal", "low", "empty"]).default("all")
}).strict();
export const valueListQuerySchema = z.object({
  page: integerQuery(1, 1000000), pageSize: integerQuery(20, 100)
}).strict();

export function queryObject(search: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of search) {
    if (key in result) throw new Error("duplicate-catalog-filter");
    if (value !== "") result[key] = value;
  }
  return result;
}
