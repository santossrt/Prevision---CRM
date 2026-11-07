import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../src/generated/prisma/client.ts";
import { formatAuditReportSnapshot, readableAuditReportValue } from "../../src/server/transfers/export-audit.ts";
import { loadReportData } from "../../src/server/transfers/export-data.ts";
import { sanitizeAuditSnapshot } from "../../src/server/audit/sanitize.ts";

describe("valores da auditoria nos relatórios", () => {
  it("mostra campos em português e mantém códigos, decimais e valores aninhados", () => {
    const formatted = formatAuditReportSnapshot(sanitizeAuditSnapshot({ name: "Coca-Cola 2L", barcode: "00001234", acquisitionCost: "12.3400", isActive: false, description: null, category: { name: "Bebidas" }, items: [{ sku: "A01" }] }));
    expect(formatted.text).toBe("Nome: Coca-Cola 2L\nCódigo de barras: 00001234\nCusto de aquisição: 12.3400\nAtivo: Não\nDescrição: Não informado\nCategoria · Nome: Bebidas\nItens [1] · SKU: A01");
    expect(formatted.limited).toBe(false);
  });
  it("mantém as indicações de omissão e limitação sem expor campos privados", () => {
    const formatted = formatAuditReportSnapshot(sanitizeAuditSnapshot({ name: "á".repeat(1200), passwordHash: "PRIVATE_VALUE", category: { name: "Bebidas", token: "PRIVATE_TOKEN" }, isActive: true }));
    expect(formatted.text).toContain("Ativo: Sim");
    expect(formatted.text).toContain("Campos fora da lista permitida foram omitidos.");
    expect(formatted.text).toContain("Exibição limitada");
    expect(formatted.text).not.toMatch(/PRIVATE_|passwordHash|token/);
    expect(formatted.limited).toBe(true);
  });
  it("limita o texto completo com aviso e trata ausências e listas vazias", () => {
    expect(formatAuditReportSnapshot(null)).toEqual({ text: null, limited: false });
    expect(formatAuditReportSnapshot(sanitizeAuditSnapshot({ items: [] })).text).toBe("Itens: Lista vazia");
    const formatted = formatAuditReportSnapshot(sanitizeAuditSnapshot({ items: Array.from({ length: 10 }, () => ({ description: "á".repeat(600) })) }));
    expect(formatted.text!.length).toBeLessThanOrEqual(4000);
    expect(formatted.text).toContain("Exibição limitada");
    expect(formatted.limited).toBe(true);
  });
  it("converte prévia antiga sem confiar em campos que não pertencem à auditoria pública", () => {
    const text = readableAuditReportValue(JSON.stringify({ values: { name: "Produto", passwordHash: "PRIVATE_VALUE" }, omitted: false, truncated: false }));
    expect(text).toContain("Nome: Produto");
    expect(text).toContain("foram omitidos");
    expect(text).not.toContain("PRIVATE_VALUE");
    expect(readableAuditReportValue('{"values":{"name":"Produto"…')).toContain("Gere uma nova prévia");
    expect(readableAuditReportValue("Nome: Produto")).toBe("Nome: Produto");
  });
  it("a fonte entrega as duas seções legíveis para prévia, Excel e PDF", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([{ createdAt: "2026-11-01T12:00:00Z", actor: "Administrador", action: "ACTIVATE", module: "PRODUCTS", entityType: "Product", entityId: "product", origin: "catalog", operationId: "operation", previous: { name: "Produto", isActive: false, passwordHash: "PRIVATE_VALUE" }, next: { name: "Produto", isActive: true } }]) } as unknown as Prisma.TransactionClient;
    const data = await loadReportData(tx, "audit", {});
    expect(data.columns.filter(({ key }) => key === "previous" || key === "next").map(({ label }) => label)).toEqual(["Valores anteriores", "Valores registrados"]);
    expect(data.rows[0].previous).toContain("Ativo: Não");
    expect(data.rows[0].next).toContain("Ativo: Sim");
    expect(JSON.stringify(data)).not.toContain("PRIVATE_VALUE");
    expect(data.rows[0].previous).not.toContain('"values":');
  });
});
