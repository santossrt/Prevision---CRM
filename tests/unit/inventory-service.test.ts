import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../src/generated/prisma/client.ts";
import type { Principal } from "../../src/server/auth/identity.ts";
import { ApplicationError } from "../../src/server/errors/application-error.ts";
import { cancelInventory, completeInventory, countInventory, createInventory, getInventory, rebaseInventory } from "../../src/server/inventory/service.ts";
import { inventoryCountsSchema, inventoryCreateSchema, inventoryRebaseSchema } from "../../src/server/inventory/validation.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown>, authorize: vi.fn() }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));
vi.mock("../../src/server/authorization/guard.ts", async (original) => ({ ...await original<typeof import("../../src/server/authorization/guard.ts")>(), assertActorInTransaction: state.authorize }));
const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const actor: Principal = { id: uuid(1), sessionId: uuid(2), sessionVersion: 0, name: "Contador", email: "counter@example.invalid", role: "ADMINISTRATOR", permissions: ["stock.read", "stock.write", "stock.adjust"], googleLinked: false, hasPassword: true, googleAccessAllowed: false };
const decimal = (value: unknown) => new Prisma.Decimal(String(value));

function fixture() {
  const stocks = new Map([1, 2, 3].map((index) => [uuid(100 + index), { productId: uuid(100 + index), quantity: decimal("5"), version: 0 }]));
  const record = {
    id: uuid(10), title: "Conferência", notes: null as string | null, status: "OPEN", version: 0, openedAt: new Date(), completedAt: null as Date | null, canceledAt: null as Date | null,
    createdById: actor.id, completedById: null as string | null, canceledById: null as string | null,
    createdBy: { id: actor.id, name: actor.name }, completedBy: null as { id: string; name: string | null } | null, canceledBy: null as { id: string; name: string | null } | null,
    items: [...stocks.values()].map((stock, index) => ({
      inventoryId: uuid(10), productId: stock.productId, name: `Produto ${index}`, sku: `SKU-${index}`, unitOfMeasure: "UN", categoryName: "Categoria",
      baselineQuantity: decimal("5"), baselineVersion: 0, countedQuantity: null as Prisma.Decimal | null, justification: null as string | null,
      countedById: null as string | null, countedAt: null as Date | null, countedBy: null as { id: string; name: string | null } | null, movementId: null as string | null,
      product: { isActive: true, unitOfMeasure: "UN", acquisitionCost: decimal("2.335"), stockBalance: stock }
    }))
  };
  const operations = new Map<string, { key: string; actorId: string; kind: string; inventoryId: string; requestHash: string }>();
  const products = record.items.map((item) => ({ id: item.productId, name: item.name, sku: item.sku, unitOfMeasure: "UN", category: { name: "Categoria" } }));
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn(async (query: TemplateStringsArray, ...values: unknown[]) => {
      if (query.join(" ").includes("FROM inventories")) return [{ id: record.id }];
      const ids = values.flatMap((value) => typeof value === "object" && value && "values" in value ? (value as { values: unknown[] }).values : [value]);
      return [...stocks.values()].filter((stock) => ids.includes(stock.productId));
    }),
    inventory: {
      findUnique: vi.fn(async () => record),
      create: vi.fn(async ({ data }: { data: { title: string; notes: string | null } }) => { record.title = data.title; record.notes = data.notes; return record; }),
      update: vi.fn(async ({ data }: { data: { version: { increment: number }; status?: string; completedAt?: Date; completedById?: string; canceledAt?: Date; canceledById?: string } }) => {
        record.version += data.version.increment;
        if (data.status) record.status = data.status;
        if (data.completedAt) { record.completedAt = data.completedAt; record.completedById = data.completedById!; record.completedBy = { id: data.completedById!, name: "Responsável" }; }
        if (data.canceledAt) { record.canceledAt = data.canceledAt; record.canceledById = data.canceledById!; record.canceledBy = { id: data.canceledById!, name: "Responsável" }; }
        return record;
      })
    },
    inventoryItem: {
      createMany: vi.fn().mockResolvedValue({ count: 3 }),
      update: vi.fn(async ({ where, data }: { where: { inventoryId_productId: { productId: string } }; data: Record<string, unknown> }) => {
        const item = record.items.find((candidate) => candidate.productId === where.inventoryId_productId.productId)!;
        Object.assign(item, data);
        if ("countedQuantity" in data) item.countedQuantity = data.countedQuantity === null ? null : decimal(data.countedQuantity);
        if (data.countedById) item.countedBy = { id: String(data.countedById), name: "Contador" };
        if (data.countedById === null) item.countedBy = null;
        return item;
      })
    },
    inventoryOperation: { findUnique: vi.fn(async ({ where }: { where: { key: string } }) => operations.get(where.key) ?? null), create: vi.fn(async ({ data }: { data: { key: string; actorId: string; kind: string; inventoryId: string; requestHash: string } }) => { operations.set(data.key, data); return data; }) },
    stockMovement: { create: vi.fn(async (_request: { data: Record<string, unknown>; select: { id: true } }) => ({ id: uuid(900 + tx.stockMovement.create.mock.calls.length) })) },
    stockBalance: { update: vi.fn(async ({ where, data }: { where: { productId: string }; data: { quantity: Prisma.Decimal } }) => { const stock = stocks.get(where.productId)!; stock.quantity = decimal(data.quantity); stock.version++; return stock; }) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) }, product: { findMany: vi.fn(async () => products) }, category: { count: vi.fn().mockResolvedValue(1) }
  };
  const database = { $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown, _options?: unknown) => work(tx)) };
  state.database = database;
  const action = (key = uuid(50)) => ({ idempotencyKey: key, expectedVersion: record.version });
  function allCounted() { record.items.forEach((item) => { item.countedQuantity = decimal("5"); item.countedById = actor.id; item.countedBy = { id: actor.id, name: actor.name }; item.countedAt = new Date(); }); }
  return { record, stocks, tx, operations, products, database, action, allCounted };
}
beforeEach(() => { state.authorize.mockReset().mockResolvedValue(undefined); });

describe("contratos de inventário", () => {
  it("aceita um único escopo e normaliza IDs sem permitir repetição", () => {
    const input = inventoryCreateSchema.parse({ title: "  Conferência  ", scope: "products", productIds: [uuid(3), uuid(1)], idempotencyKey: uuid(5) });
    expect(input.scope === "products" && input.productIds).toEqual([uuid(1), uuid(3)]);
    expect(inventoryCreateSchema.safeParse({ title: "Teste", scope: "all", productIds: [uuid(1)], idempotencyKey: uuid(5) }).success).toBe(false);
    expect(inventoryRebaseSchema.safeParse({ expectedVersion: 0, idempotencyKey: uuid(5), productIds: [uuid(1), uuid(1)] }).success).toBe(false);
  });
  it("aceita contagem zero, precisão4 e lotes limitados, sem valores negativos ou campos extras", () => {
    const body = { expectedVersion: 0, idempotencyKey: uuid(5), items: [{ productId: uuid(1), countedQuantity: "000.0" }] };
    expect(inventoryCountsSchema.parse(body).items[0].countedQuantity).toBe("0.0000");
    for (const value of ["-1", "1e3", "0.12345", "100000000000000"]) expect(inventoryCountsSchema.safeParse({ ...body, items: [{ ...body.items[0], countedQuantity: value }] }).success).toBe(false);
    expect(inventoryCountsSchema.safeParse({ ...body, items: Array.from({ length: 21 }, (_, index) => ({ productId: uuid(100 + index), countedQuantity: "1" })) }).success).toBe(false);
    expect(inventoryCountsSchema.safeParse({ ...body, items: [body.items[0], body.items[0]] }).success).toBe(false);
  });
});

describe("inventários transacionais e idempotentes", () => {
  it("bloqueia escrita/confirmação sem permissão e revalida sessão após os locks", async () => {
    const { database, action, tx } = fixture();
    await expect(createInventory({ ...actor, permissions: ["stock.read"] }, { title: "Conferência", scope: "all", idempotencyKey: uuid(50) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(completeInventory({ ...actor, permissions: ["stock.write"] }, uuid(10), action())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(database.$transaction).not.toHaveBeenCalled();
    state.authorize.mockRejectedValue(new ApplicationError("UNAUTHORIZED", "Sessão revogada."));
    await expect(createInventory(actor, { title: "Conferência", scope: "all", idempotencyKey: uuid(50) })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2); expect(tx.inventory.create).not.toHaveBeenCalled();
  });
  it("abre com referências exatas sem alterar saldos e não expõe chaves/hashes", async () => {
    const { tx } = fixture();
    const result = await createInventory(actor, { title: "Conferência", scope: "all", idempotencyKey: uuid(50) });
    expect(result.inventory.items[0]).toMatchObject({ baselineQuantity: "5.0000", baselineVersion: 0, countedQuantity: null });
    expect(tx.stockBalance.update).not.toHaveBeenCalled(); expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(tx.inventoryOperation.create.mock.calls[0][0].data.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("requestHash"); expect(JSON.stringify(result)).not.toContain("idempotencyKey");
  });
  it("não trunca o escopo acima de 200 produtos", async () => {
    const { tx, products } = fixture();
    tx.product.findMany.mockResolvedValue(Array.from({ length: 201 }, () => products[0]));
    await expect(createInventory(actor, { title: "Conferência", scope: "all", idempotencyKey: uuid(50) })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(tx.inventory.create).not.toHaveBeenCalled();
  });
  it("exige justificativa só quando a contagem diverge", async () => {
    const { tx, record, action } = fixture();
    await expect(countInventory(actor, record.id, { ...action(), items: [{ productId: record.items[0].productId, countedQuantity: "0" }] })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(tx.inventoryItem.update).not.toHaveBeenCalled();
    const result = await countInventory(actor, record.id, { ...action(), items: [{ productId: record.items[0].productId, countedQuantity: "0", justification: "Perda identificada" }] });
    expect(result.inventory.items[0]).toMatchObject({ countedQuantity: "0.0000", difference: "-5.0000", countedBy: { id: actor.id } });
    expect(tx.stockBalance.update).not.toHaveBeenCalled();
  });
  it("replay normalizado da contagem não repete versão, auditoria ou efeitos", async () => {
    const { record, action, tx } = fixture();
    const input = { ...action(), items: [{ productId: record.items[0].productId, countedQuantity: "5" }] };
    await countInventory(actor, record.id, input);
    const result = await countInventory(actor, record.id, { ...input, items: [{ ...input.items[0], countedQuantity: "05.0000", justification: null }] });
    expect(result.replayed).toBe(true); expect(result.inventory.version).toBe(1);
    expect(tx.inventory.update).toHaveBeenCalledTimes(1); expect(tx.auditEvent.create).toHaveBeenCalledTimes(1);
    await expect(countInventory(actor, record.id, { ...input, items: [{ ...input.items[0], countedQuantity: "4", justification: "Outra contagem" }] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(countInventory({ ...actor, id: uuid(99) }, record.id, input)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("evita perder contagem salva por outra pessoa", async () => {
    const { record, action, tx } = fixture();
    const input = action(); record.version++;
    await expect(countInventory(actor, record.id, { ...input, items: [{ productId: record.items[0].productId, countedQuantity: "5" }] })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.inventoryItem.update).not.toHaveBeenCalled();
  });
  it("rebase atualiza só os itens selecionados e obriga nova contagem desses itens", async () => {
    const { record, allCounted, stocks, action, tx } = fixture(); allCounted();
    stocks.get(record.items[0].productId)!.quantity = decimal("7"); stocks.get(record.items[0].productId)!.version++;
    const result = await rebaseInventory(actor, record.id, { ...action(), productIds: [record.items[0].productId] });
    expect(result.inventory.items[0]).toMatchObject({ baselineQuantity: "7.0000", baselineVersion: 1, countedQuantity: null, countedBy: null, countedAt: null, justification: null });
    expect(result.inventory.items[1].countedQuantity).toBe("5.0000"); expect(tx.stockBalance.update).not.toHaveBeenCalled();
    await expect(completeInventory(actor, record.id, action(uuid(51)))).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("bloqueia confirmação quando saldo mudou e voltou à mesma quantidade", async () => {
    const { record, allCounted, stocks, action, tx } = fixture(); allCounted();
    stocks.get(record.items[1].productId)!.version += 2;
    expect((await getInventory(actor, record.id)).items[1].stockChanged).toBe(true);
    await expect(completeInventory(actor, record.id, action())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });
  it("troca de unidade exige reiniciar o inventário, sem aceitar rebase ou contagem antiga", async () => {
    const { record, allCounted, action, tx } = fixture(); allCounted(); record.items[0].product.unitOfMeasure = "KG";
    expect((await getInventory(actor, record.id)).items[0].stockChanged).toBe(true);
    await expect(completeInventory(actor, record.id, action())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(rebaseInventory(actor, record.id, { ...action(), productIds: [record.items[0].productId] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(countInventory(actor, record.id, { ...action(), items: [{ productId: record.items[0].productId, countedQuantity: "5" }] })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });
  it("confirma somente divergências e agrupa movimentos/auditoria na mesma operação", async () => {
    const { record, allCounted, action, tx, stocks } = fixture(); allCounted();
    record.items[0].countedQuantity = decimal("4.5"); record.items[0].justification = "Avaria";
    record.items[1].countedQuantity = decimal("5.5"); record.items[1].justification = "Unidade encontrada";
    const body = action(); const result = await completeInventory(actor, record.id, body);
    expect(result.inventory.status).toBe("COMPLETED"); expect(result.inventory.divergentItems).toBe(2);
    expect(tx.stockMovement.create).toHaveBeenCalledTimes(2); expect(tx.stockBalance.update).toHaveBeenCalledTimes(2);
    const first = tx.stockMovement.create.mock.calls[0][0] as unknown as { data: Record<string, unknown> };
    const second = tx.stockMovement.create.mock.calls[1][0] as unknown as { data: Record<string, unknown> };
    expect(first.data).toMatchObject({ type: "NEGATIVE_ADJUSTMENT", quantityDelta: "-0.5000", historicalUnitCost: "2.3350", historicalTotalCost: "1.17" });
    expect(second.data.operationId).toBe(first.data.operationId);
    expect(stocks.get(record.items[2].productId)!.version).toBe(0);
    record.items[0].product.acquisitionCost = decimal("999");
    expect((await completeInventory(actor, record.id, body)).replayed).toBe(true);
    expect(tx.stockMovement.create).toHaveBeenCalledTimes(2);
  });
  it("valida todos os valores antes de emitir o primeiro movimento", async () => {
    const { record, allCounted, action, tx } = fixture(); allCounted();
    record.items[0].countedQuantity = decimal("4"); record.items[0].justification = "Diferença";
    record.items[2].countedQuantity = decimal("99999999999999.9999"); record.items[2].justification = "Erro de contagem";
    record.items[2].product.acquisitionCost = decimal("99999999999999.9999");
    await expect(completeInventory(actor, record.id, action())).rejects.toMatchObject({ code: "VALIDATION" });
    expect(tx.stockMovement.create).not.toHaveBeenCalled(); expect(tx.stockBalance.update).not.toHaveBeenCalled();
  });
  it("permite cancelar ao criador ou ajustador e mantém histórico sem alterar saldo", async () => {
    const { record, action, tx } = fixture();
    const operator = { ...actor, permissions: ["stock.read", "stock.write"] };
    await expect(cancelInventory({ ...operator, id: uuid(99) }, record.id, action())).rejects.toMatchObject({ code: "FORBIDDEN" });
    const result = await cancelInventory(operator, record.id, action());
    expect(result.inventory.status).toBe("CANCELED"); expect(tx.stockBalance.update).not.toHaveBeenCalled();
    await expect(countInventory(actor, record.id, { ...action(uuid(51)), items: [{ productId: record.items[0].productId, countedQuantity: "5" }] })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
