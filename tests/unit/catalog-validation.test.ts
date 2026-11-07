import { describe, expect, it } from "vitest";
import { catalogDecimalSchema, productCreateSchema, productUpdateSchema, supplierCreateSchema, categoryUpdateSchema, productListQuerySchema, queryObject } from "../../src/server/catalog/validation.ts";

const categoryId = "00000000-0000-4000-8000-000000000001";

describe("validação dos cadastros", () => {
  it("preserva exatamente valores decimais e normaliza apenas sua representação", () => {
    expect(catalogDecimalSchema.parse("00001.2")).toBe("1.2000");
    expect(catalogDecimalSchema.parse("99999999999999.9999")).toBe("99999999999999.9999");
    expect(catalogDecimalSchema.parse("0.0001")).toBe("0.0001");
    expect(catalogDecimalSchema.parse("0000000000000000.0")).toBe("0.0000");
  });
  it.each(["-1", "NaN", "Infinity", "1e4", "1,23", "0.00001", "100000000000000", "", 0.1, null])("recusa decimal inválido %s", (value) => {
    expect(catalogDecimalSchema.safeParse(value).success).toBe(false);
  });
  it("normaliza SKU sem eliminar zeros do código de barras", () => {
    const data = productCreateSchema.parse({ name: "  Produto   exemplo ", sku: " sku-01 ", barcode: "0000123", categoryId });
    expect(data).toMatchObject({ name: "Produto exemplo", sku: "SKU-01", barcode: "0000123", minimumStock: "0.0000", acquisitionCost: "0.0000", unitOfMeasure: "UN" });
  });
  it("rejeita alteração direta de saldo e campos não previstos", () => {
    expect(productCreateSchema.safeParse({ name: "Produto", sku: "SKU", categoryId, quantity: "100" }).success).toBe(false);
    expect(productUpdateSchema.safeParse({ expectedVersion: 0, stockBalance: { quantity: "10" } }).success).toBe(false);
    expect(productUpdateSchema.safeParse({ salePrice: "10.0000" }).success).toBe(false);
    expect(categoryUpdateSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
  });
  it("normaliza documento alfanumérico e permite limpar contatos opcionais", () => {
    expect(supplierCreateSchema.parse({ name: "Fornecedor", taxId: " ab.12/34-xy ", email: "", phone: " " })).toMatchObject({ taxId: "AB1234XY", email: null, phone: null });
    expect(supplierCreateSchema.safeParse({ name: "Fornecedor", email: "invalido" }).success).toBe(false);
  });
  it("valida filtros, paginação e duplicação sem aceitar campos arbitrários", () => {
    expect(productListQuerySchema.parse(queryObject(new URLSearchParams("search=produto&page=2&pageSize=10&stock=low")))).toMatchObject({ page: 2, pageSize: 10, stock: "low", status: "active" });
    for (const query of ["page=0", "pageSize=101", "stock=desconhecido", "unsafe=true"]) expect(productListQuerySchema.safeParse(queryObject(new URLSearchParams(query))).success).toBe(false);
    expect(() => queryObject(new URLSearchParams("search=a&search=b"))).toThrow();
  });
});
