import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../src/generated/prisma/client.ts";
import type { Principal } from "../../src/server/auth/identity.ts";
import { ApplicationError } from "../../src/server/errors/application-error.ts";
import { createProduct, updateProduct, createCategory } from "../../src/server/catalog/service.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown>, validateActor: vi.fn() }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));
vi.mock("../../src/server/authorization/guard.ts", async (original) => ({ ...await original<typeof import("../../src/server/authorization/guard.ts")>(), assertActorInTransaction: state.validateActor }));

const userId = "00000000-0000-4000-8000-000000000001";
const productId = "00000000-0000-4000-8000-000000000002";
const categoryId = "00000000-0000-4000-8000-000000000003";
const actor: Principal = { id: userId, sessionId: "00000000-0000-4000-8000-000000000004", sessionVersion: 0, name: "Operador", email: "operator@example.invalid", role: "OPERATOR", permissions: ["catalog.read", "catalog.write"], googleLinked: false, hasPassword: true, googleAccessAllowed: false };
const instant = new Date("2026-10-31T00:00:00Z");
function fixture() {
  const category = { id: categoryId, name: "Categoria", isActive: true };
  const record = {
    id: productId, name: "Produto", sku: "SKU", barcode: "000123", description: null,
    categoryId, defaultSupplierId: null, category, defaultSupplier: null, unitOfMeasure: "UN",
    minimumStock: new Prisma.Decimal("2.0000"), safetyStock: new Prisma.Decimal(0), acquisitionCost: new Prisma.Decimal("1.2345"), salePrice: new Prisma.Decimal("9.8765"),
    stockBalance: { quantity: new Prisma.Decimal(0) }, replenishmentLeadTimeDays: null, isActive: true, version: 0, createdAt: instant, updatedAt: instant
  };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    product: { findUnique: vi.fn().mockResolvedValue(record), updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn().mockResolvedValue(record) },
    category: { findUnique: vi.fn().mockResolvedValue(category), create: vi.fn() },
    supplier: { findUnique: vi.fn() },
    productValueHistory: { createMany: vi.fn() }, auditEvent: { create: vi.fn() }
  };
  const database = { $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown) => work(tx)) };
  state.database = database;
  return { tx, record, category, database };
}
beforeEach(() => { state.validateActor.mockReset(); state.validateActor.mockResolvedValue(undefined); });

describe("integridade das alterações de catálogo", () => {
  it("recusa ator revogado após esperar pelo lock, sem salvar cadastro", async () => {
    const { tx } = fixture();
    state.validateActor.mockRejectedValue(new ApplicationError("UNAUTHORIZED", "Sessão revogada."));
    await expect(createCategory(actor, { name: "Categoria" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.category.create).not.toHaveBeenCalled();
  });
  it("exige permissão de escrita antes de consultar ou alterar dados", async () => {
    const { database } = fixture();
    await expect(createProduct({ ...actor, permissions: ["catalog.read"] }, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(database.$transaction).not.toHaveBeenCalled();
  });
  it("rejeita cadastro de produto com categoria inativa", async () => {
    const { tx, category } = fixture(); category.isActive = false;
    await expect(createProduct(actor, { name: "Produto", sku: "SKU", categoryId })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(tx.product.create).not.toHaveBeenCalled();
  });
  it("permite preservar uma referência inativa em edição que não a substitui", async () => {
    const { tx, category, record } = fixture(); category.isActive = false;
    tx.product.findUnique.mockResolvedValueOnce(record).mockResolvedValue({ ...record, name: "Nome corrigido", version: 1 });
    await expect(updateProduct(actor, productId, { expectedVersion: 0, name: "Nome corrigido" })).resolves.toMatchObject({ version: 1 });
    expect(tx.productValueHistory.createMany).not.toHaveBeenCalled();
  });
  it("exige referências ativas ao reativar produto", async () => {
    const { tx, category, record } = fixture(); category.isActive = false; record.isActive = false;
    await expect(updateProduct(actor, productId, { expectedVersion: 0, isActive: true })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });
  it("recusa versão antiga sem alterar cadastro ou histórico", async () => {
    const { tx, record } = fixture(); record.version = 1;
    await expect(updateProduct(actor, productId, { expectedVersion: 0, salePrice: "20" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(tx.productValueHistory.createMany).not.toHaveBeenCalled();
  });
  it("registra somente a alteração real de preço com precisão e operação auditada", async () => {
    const { tx, record } = fixture();
    tx.product.findUnique.mockResolvedValueOnce(record).mockResolvedValue({ ...record, salePrice: new Prisma.Decimal("10.0001"), version: 1 });
    await updateProduct(actor, productId, { expectedVersion: 0, salePrice: "10.0001" });
    const entry = tx.productValueHistory.createMany.mock.calls[0][0].data[0];
    expect(entry.type).toBe("SALE_PRICE");
    expect(entry.previousValue.toFixed(4)).toBe("9.8765");
    expect(entry.newValue.toFixed(4)).toBe("10.0001");
    expect(entry.changedById).toBe(userId);
    expect(tx.auditEvent.create.mock.calls[0][0].data.operationId).toBe(entry.operationId);
  });
});
