import { describe, expect, it } from "vitest";
import { fixed, movementTotal, resultingQuantity, totalCents } from "../../src/server/stock/calculations.ts";
import { balanceQuerySchema, compensationCreateSchema, movementCreateSchema, movementQuerySchema, parseStockQuery } from "../../src/server/stock/validation.ts";

const base = {
  productId: "00000000-0000-4000-8000-000000000001", quantity: "1.0000", occurredAt: "2026-10-31T12:00:00-03:00",
  idempotencyKey: "00000000-0000-4000-8000-000000000002"
};
const supplierId = "00000000-0000-4000-8000-000000000003";

describe("aritmética de estoque e valores históricos", () => {
  it("soma frações sem conversão binária e preserva quatro casas", () => {
    expect(resultingQuantity("0.1000", "0.2000")).toBe("0.3000");
    expect(resultingQuantity("0.3000", "-0.3000")).toBe("0.0000");
  });
  it("arredonda o total half up somente após multiplicar a quantidade exata", () => {
    expect(movementTotal("0.0001", "50.0000")).toBe("0.01");
    expect(movementTotal("0.3333", "0.0150")).toBe("0.00");
    expect(movementTotal("3.0000", "0.3350")).toBe("1.01");
    expect(movementTotal("-3.0000", "0.3350")).toBe("1.01");
  });
  it("mantém precisão no limite de quatorze dígitos inteiros", () => {
    expect(resultingQuantity("99999999999999.9998", "0.0001")).toBe("99999999999999.9999");
    expect(movementTotal("99999999999999.9999", "0.0001")).toBe("10000000000.00");
  });
  it("bloqueia saldo negativo e overflow de saldo ou total antes de persistir", () => {
    expect(() => resultingQuantity("0.0000", "-0.0001")).toThrow("Saldo insuficiente");
    expect(() => resultingQuantity("99999999999999.9999", "0.0001")).toThrow("saldo resultante");
    expect(() => movementTotal("99999999999999.9999", "99999999999999.9999")).toThrow("valor total");
  });
  it("permite estimativas sem limite de coluna e margem negativa sem perder centavos", () => {
    const cost = totalCents("99999999999999.9999", "99999999999999.9999");
    expect(fixed(cost, 2)).toBe("9999999999999999980000000000.00");
    expect(fixed(100n - 300n, 2)).toBe("-2.00");
  });
});

describe("contratos de movimentação", () => {
  it("normaliza decimais, textos e datas equivalentes antes da idempotência", () => {
    expect(movementCreateSchema.parse({ ...base, type: "ENTRY", quantity: "0001.2", unitCost: "2", supplierId, notes: "  compra  " }))
      .toMatchObject({ quantity: "1.2000", unitCost: "2.0000", notes: "compra", occurredAt: "2026-10-31T15:00:00.000Z" });
  });
  it("exige fornecedor/custo na entrada e preço na saída", () => {
    expect(movementCreateSchema.safeParse({ ...base, type: "ENTRY", unitCost: "1" }).success).toBe(false);
    expect(movementCreateSchema.safeParse({ ...base, type: "ENTRY", supplierId }).success).toBe(false);
    expect(movementCreateSchema.safeParse({ ...base, type: "EXIT" }).success).toBe(false);
  });
  it.each(["0", "-1", "1.23456", "1e3", "NaN", "100000000000000", 1])("recusa quantidade inválida %s", (quantity) => {
    expect(movementCreateSchema.safeParse({ ...base, quantity, type: "EXIT", unitPrice: "1" }).success).toBe(false);
  });
  it("não aceita campos de outros tipos, saldo direto ou compensação arbitrária", () => {
    expect(movementCreateSchema.safeParse({ ...base, type: "EXIT", unitPrice: "1", unitCost: "1" }).success).toBe(false);
    expect(movementCreateSchema.safeParse({ ...base, type: "ENTRY", unitCost: "1", supplierId, quantityAfter: "999" }).success).toBe(false);
    expect(movementCreateSchema.safeParse({ ...base, type: "COMPENSATION", compensatesMovementId: supplierId }).success).toBe(false);
  });
  it("exige justificativa não vazia em ajustes e compensações", () => {
    expect(movementCreateSchema.safeParse({ ...base, type: "POSITIVE_ADJUSTMENT", justification: "  " }).success).toBe(false);
    expect(movementCreateSchema.safeParse({ ...base, type: "NEGATIVE_ADJUSTMENT", justification: "avaria" }).success).toBe(true);
    expect(compensationCreateSchema.safeParse({ idempotencyKey: base.idempotencyKey, justification: "" }).success).toBe(false);
  });
  it("rejeita datas sem fuso, filtros desconhecidos, repetidos e período invertido", () => {
    expect(movementCreateSchema.safeParse({ ...base, type: "EXIT", unitPrice: "1", occurredAt: "2026-10-31T12:00:00" }).success).toBe(false);
    expect(() => parseStockQuery(balanceQuerySchema, new URLSearchParams("search=a&search=b"))).toThrow("Filtros inválidos");
    expect(() => parseStockQuery(balanceQuerySchema, new URLSearchParams("quantity=99"))).toThrow("Filtros inválidos");
    expect(movementQuerySchema.safeParse({ from: "2026-10-31T12:00:00Z", to: "2026-10-30T12:00:00Z" }).success).toBe(false);
    expect(parseStockQuery(balanceQuerySchema, new URLSearchParams()).status).toBe("all");
  });
  it("rejeita filtros repetidos mesmo quando o primeiro valor ou ambos estão vazios", () => {
    expect(() => parseStockQuery(balanceQuerySchema, new URLSearchParams("page=&page=2"))).toThrow("Filtros inválidos");
    expect(() => parseStockQuery(balanceQuerySchema, new URLSearchParams("search=&search="))).toThrow("Filtros inválidos");
  });
});
