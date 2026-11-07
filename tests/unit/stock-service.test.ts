import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../src/generated/prisma/client.ts";
import type { Principal } from "../../src/server/auth/identity.ts";
import { ApplicationError } from "../../src/server/errors/application-error.ts";
import { compensateMovement, createMovement } from "../../src/server/stock/service.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown>, validateActor: vi.fn() }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));
vi.mock("../../src/server/authorization/guard.ts", async (original) => ({
  ...await original<typeof import("../../src/server/authorization/guard.ts")>(), assertActorInTransaction: state.validateActor
}));

const actorId = "00000000-0000-4000-8000-000000000001";
const productId = "00000000-0000-4000-8000-000000000002";
const supplierId = "00000000-0000-4000-8000-000000000003";
const key = "00000000-0000-4000-8000-000000000004";
const anotherKey = "00000000-0000-4000-8000-000000000005";
const actor: Principal = { id: actorId, name: "Responsável", email: "operator@example.invalid", role: "ADMINISTRATOR", sessionId: key, sessionVersion: 0, permissions: ["stock.read", "stock.write", "stock.adjust"], googleLinked: false, hasPassword: true, googleAccessAllowed: false };
const decimal = (value: unknown) => new Prisma.Decimal(String(value));

function fixture() {
  const product = { id: productId, name: "Produto", sku: "SKU-1", unitOfMeasure: "UN", isActive: true, acquisitionCost: decimal("2.3456"), salePrice: decimal("9.8765") };
  const balance = { productId, quantity: decimal("5.0000"), version: 0 };
  const movements = new Map<string, Record<string, any>>();
  const party = { id: supplierId, name: "Fornecedor", isActive: true };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1), $queryRaw: vi.fn(async (_query: TemplateStringsArray, ..._values: unknown[]) => [balance]),
    product: { findUnique: vi.fn(async () => product) },
    supplier: { findUnique: vi.fn(async () => party) }, customer: { findUnique: vi.fn(async () => party) },
    stockBalance: { update: vi.fn(async ({ data }: { data: { quantity: string } }) => { balance.quantity = decimal(data.quantity); balance.version++; return balance; }) },
    stockMovement: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => [...movements.values()].find((record) => where.id ? record.id === where.id : record.idempotencyKey === where.idempotencyKey) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        const record: Record<string, any> = {
          id: `00000000-0000-4000-8000-${(movements.size + 10).toString().padStart(12, "0")}`, ...data,
          product: { id: productId, name: product.name, sku: product.sku, unitOfMeasure: "UN" },
          supplier: data.supplierId ? party : null, customer: data.customerId ? party : null,
          performedBy: { id: actorId, name: actor.name }, notes: data.notes ?? null, justification: data.justification ?? null,
          compensatesMovementId: data.compensatesMovementId ?? null, compensation: null
        };
        for (const field of ["quantityDelta", "quantityBefore", "quantityAfter", "historicalUnitCost", "historicalTotalCost", "historicalUnitPrice", "historicalTotalPrice"]) {
          record[field] = data[field] === null || data[field] === undefined ? null : decimal(data[field]);
        }
        movements.set(record.id, record);
        if (record.compensatesMovementId) movements.get(record.compensatesMovementId)!.compensation = { id: record.id };
        return record;
      })
    },
    auditEvent: { create: vi.fn().mockResolvedValue({}) }
  };
  const database = { $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown, _options?: unknown) => work(tx)) };
  state.database = database;
  const base = { productId, quantity: "1.0000", occurredAt: new Date(Date.now() - 1000).toISOString(), idempotencyKey: key };
  const entry = { ...base, type: "ENTRY", supplierId, unitCost: "3.3350" };
  const exit = { ...base, type: "EXIT", unitPrice: "8.3350" };
  return { product, balance, movements, party, tx, database, base, entry, exit };
}
beforeEach(() => { state.validateActor.mockReset().mockResolvedValue(undefined); });

describe("controle transacional de estoque", () => {
  it("nega escrita e ajustes sem permissão antes de abrir transação", async () => {
    const { entry, base, database } = fixture();
    await expect(createMovement({ ...actor, permissions: ["stock.read"] }, entry)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createMovement({ ...actor, permissions: ["stock.write"] }, { ...base, type: "POSITIVE_ADJUSTMENT", justification: "contagem" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(database.$transaction).not.toHaveBeenCalled();
  });
  it("revalida a sessão após os locks e não persiste ator revogado", async () => {
    const { entry, tx, database } = fixture();
    state.validateActor.mockRejectedValue(new ApplicationError("UNAUTHORIZED", "Sessão revogada."));
    await expect(createMovement(actor, entry)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(database.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: "ReadCommitted" });
  });
  it("registra entrada com snapshot próprio, saldo e auditoria; não muda custo do cadastro", async () => {
    const { entry, tx, product, balance } = fixture();
    const result = await createMovement(actor, entry);
    expect(result.replayed).toBe(false);
    expect(result.movement).toMatchObject({ quantityBefore: "5.0000", quantityAfter: "6.0000", historicalUnitCost: "3.3350", historicalTotalCost: "3.34", historicalUnitPrice: null });
    expect(product.acquisitionCost.toFixed(4)).toBe("2.3456");
    expect(balance.version).toBe(1);
    const created = tx.stockMovement.create.mock.calls[0][0].data;
    expect(created.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.$queryRaw.mock.calls[0][0].join(" ")).toContain("FOR UPDATE");
    const audit = tx.auditEvent.create.mock.calls[0][0];
    expect(audit.data.action).toBe("STOCK_ENTRY");
    expect(JSON.stringify(audit)).not.toContain(created.requestHash);
    expect(result.movement).not.toHaveProperty("requestHash");
    expect(result.movement).not.toHaveProperty("idempotencyKey");
  });
  it("saída preserva custo do catálogo e o preço praticado, com totais independentes", async () => {
    const { exit } = fixture();
    const { movement } = await createMovement(actor, exit);
    expect(movement).toMatchObject({ quantityDelta: "-1.0000", quantityAfter: "4.0000", historicalUnitCost: "2.3456", historicalTotalCost: "2.35", historicalUnitPrice: "8.3350", historicalTotalPrice: "8.34" });
  });
  it("um replay normalizado não lança novamente nem depende do catálogo atual", async () => {
    const { entry, tx, product } = fixture();
    const first = await createMovement(actor, entry);
    product.isActive = false;
    product.acquisitionCost = decimal("999");
    const result = await createMovement(actor, { ...entry, quantity: "0001", unitCost: "03.335" });
    expect(result).toEqual({ movement: first.movement, replayed: true });
    expect(tx.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(tx.stockBalance.update).toHaveBeenCalledTimes(1);
    expect(tx.auditEvent.create).toHaveBeenCalledTimes(1);
  });
  it("rejeita reutilização da chave com outro conteúdo ou responsável", async () => {
    const { entry, tx } = fixture();
    await createMovement(actor, entry);
    await expect(createMovement(actor, { ...entry, quantity: "2" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createMovement({ ...actor, id: supplierId }, entry)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.stockMovement.create).toHaveBeenCalledTimes(1);
  });
  it("bloqueia saldo negativo, overflow e data futura antes do movimento", async () => {
    const { exit, base, tx, balance } = fixture();
    await expect(createMovement(actor, { ...exit, quantity: "6" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(createMovement(actor, { ...exit, occurredAt: new Date(Date.now() + 3600000).toISOString() })).rejects.toMatchObject({ code: "VALIDATION" });
    balance.quantity = decimal("99999999999999.9999");
    await expect(createMovement(actor, { ...base, type: "POSITIVE_ADJUSTMENT", justification: "saldo inicial" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createMovement(actor, { ...exit, quantity: "99999999999999.9999", unitPrice: "99999999999999.9999" })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });
  it("rejeita produto ou fornecedor inativo", async () => {
    const { entry, tx, product, party } = fixture();
    party.isActive = false;
    await expect(createMovement(actor, entry)).rejects.toMatchObject({ code: "VALIDATION" });
    party.isActive = true; product.isActive = false;
    await expect(createMovement(actor, entry)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });
  it("compensação inverte a operação inteira e preserva snapshots e referências inativos", async () => {
    const { entry, product, party, tx, balance } = fixture();
    const first = await createMovement(actor, entry);
    product.isActive = false; party.isActive = false; product.acquisitionCost = decimal("900");
    const body = { idempotencyKey: anotherKey, justification: "Compra duplicada" };
    const result = await compensateMovement(actor, first.movement.id, body);
    expect(result.movement).toMatchObject({ type: "COMPENSATION", quantityDelta: "-1.0000", quantityBefore: "6.0000", quantityAfter: "5.0000", historicalUnitCost: "3.3350", historicalTotalCost: "3.34", compensatesMovementId: first.movement.id, supplier: { id: supplierId } });
    expect(balance.version).toBe(2);
    expect((await compensateMovement(actor, first.movement.id, body)).replayed).toBe(true);
    expect(tx.stockMovement.create).toHaveBeenCalledTimes(2);
    await expect(compensateMovement(actor, first.movement.id, { ...body, idempotencyKey: supplierId })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(compensateMovement(actor, result.movement.id, { ...body, idempotencyKey: supplierId })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("não compensa entrada se seu inverso levar o saldo atual abaixo de zero", async () => {
    const { entry, balance, tx } = fixture();
    const first = await createMovement(actor, { ...entry, quantity: "10" });
    balance.quantity = decimal("1");
    await expect(compensateMovement(actor, first.movement.id, { idempotencyKey: anotherKey, justification: "Compra indevida" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.stockMovement.create).toHaveBeenCalledTimes(1);
  });
});
