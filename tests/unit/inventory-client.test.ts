import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryDTO } from "../../src/lib/inventory/types.ts";
import { InventorySubmissionError, inventoryStorageKey, recoverInventoryIntent, submitInventoryIntent, type InventoryIntent } from "../../src/components/inventory/inventory-api.ts";
import { quantityDifference } from "../../src/components/inventory/inventory-format.ts";

const inventoryId = "00000000-0000-4000-8000-000000000001";
const productId = "00000000-0000-4000-8000-000000000002";
const key = "00000000-0000-4000-8000-000000000003";
const ownerId = "00000000-0000-4000-8000-000000000004";
const review = { title: "Conferir pedido", description: "Descrição da operação de teste", lines: ["Um produto"] };
const create = { kind: "CREATE", body: { scope: "all", title: "Conferência de teste", idempotencyKey: key }, review } as const satisfies InventoryIntent;
const count = { kind: "COUNT", inventoryId, body: { expectedVersion: 2, idempotencyKey: key, items: [{ productId, countedQuantity: "0.0000", justification: "Conferido fisicamente" }] }, review } satisfies InventoryIntent;
const rebase = { kind: "REBASE", inventoryId, body: { expectedVersion: 2, idempotencyKey: key, productIds: [productId] }, review } satisfies InventoryIntent;
const complete = { kind: "COMPLETE", inventoryId, body: { expectedVersion: 2, idempotencyKey: key }, review } satisfies InventoryIntent;
const cancel = { kind: "CANCEL", inventoryId, body: { expectedVersion: 2, idempotencyKey: key }, review } satisfies InventoryIntent;
const result: InventoryDTO = {
  id: inventoryId, title: "Conferência de teste", status: "OPEN", version: 3,
  openedAt: "2026-10-31T12:00:00.000Z", completedAt: null, canceledAt: null,
  createdBy: { id: ownerId, name: "Responsável de teste" }, completedBy: null, canceledBy: null,
  itemCount: 0, countedItems: 0, divergentItems: 0, changedItems: 0, notes: null, items: []
};

beforeEach(() => vi.stubGlobal("document", { cookie: "another=value; prevision.csrf=csrf%2Dtest" }));
afterEach(() => vi.unstubAllGlobals());

describe("prévia da divergência física", () => {
  it.each([
    ["0.0000", "0.0000", "0.0000"],
    ["0.0000", "0.0001", "-0.0001"],
    ["99999999999999.9999", "0.0001", "99999999999999.9998"],
    ["99999999999999.9998", "99999999999999.9999", "-0.0001"]
  ])("compara %s com %s sem perder casas decimais", (physical, baseline, expected) => {
    expect(quantityDifference(physical, baseline)).toBe(expected);
  });
});

describe("transporte das intenções de inventário", () => {
  it.each<[InventoryIntent, string, string]>([
    [create, "/api/inventories", "POST"],
    [count, `/api/inventories/${inventoryId}/counts`, "PATCH"],
    [rebase, `/api/inventories/${inventoryId}/rebase`, "POST"],
    [complete, `/api/inventories/${inventoryId}/complete`, "POST"],
    [cancel, `/api/inventories/${inventoryId}/cancel`, "POST"]
  ])("envia a ação para a rota e método correspondentes", async (intent, path, method) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ inventory: result, replayed: false }));
    vi.stubGlobal("fetch", fetch);
    expect(await submitInventoryIntent(intent)).toEqual({ inventory: result, replayed: false });
    expect(fetch).toHaveBeenCalledWith(path, expect.objectContaining({
      method, credentials: "same-origin", cache: "no-store", body: JSON.stringify(intent.body),
      headers: { "Content-Type": "application/json", "X-Prevision-CSRF": "csrf-test" }
    }));
  });

  it("repete o corpo e a chave após falha de rede e 503, até receber o replay", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("conexão interrompida"))
      .mockResolvedValueOnce(Response.json({ message: "Serviço indisponível." }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ inventory: result, replayed: true }));
    vi.stubGlobal("fetch", fetch);
    const snapshot = JSON.stringify(complete);
    await expect(submitInventoryIntent(complete)).rejects.toMatchObject({ uncertain: true });
    await expect(submitInventoryIntent(complete)).rejects.toMatchObject({ uncertain: true });
    expect((await submitInventoryIntent(complete)).replayed).toBe(true);
    expect(JSON.stringify(complete)).toBe(snapshot);
    const bodies = fetch.mock.calls.map((call) => (call[1] as RequestInit).body);
    expect(bodies).toEqual([JSON.stringify(complete.body), JSON.stringify(complete.body), JSON.stringify(complete.body)]);
  });

  it.each([Response.json({ unexpected: true }), new Response("resposta incompleta", { status: 200 })])("trata uma resposta de sucesso incompleta como resultado incerto", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(submitInventoryIntent(complete)).rejects.toMatchObject({ uncertain: true });
  });

  it.each([400, 401, 403, 409, 429])("identifica a rejeição HTTP %s da tentativa atual", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: "Pedido recusado." }, { status })));
    await expect(submitInventoryIntent(count)).rejects.toMatchObject({ uncertain: false, message: "Pedido recusado." });
  });

  it("não usa um objeto como mensagem da interface", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: { private: "do-not-render" } }, { status: 400 })));
    try { await submitInventoryIntent(count); throw new Error("O pedido precisa ser recusado."); }
    catch (error) {
      expect(error).toBeInstanceOf(InventorySubmissionError);
      expect((error as Error).message).toBe("Não foi possível confirmar o pedido.");
      expect((error as Error).message).not.toContain("do-not-render");
    }
  });
});

describe("recuperação local de pedidos de inventário", () => {
  it.each([create, count, rebase, complete, cancel])("recupera uma intenção válida sem trocar a chave", (intent) => {
    expect(recoverInventoryIntent(JSON.stringify({ intent }))).toEqual(intent);
  });

  it("separa a pendência pelo identificador do usuário", () => {
    expect(inventoryStorageKey(ownerId)).not.toBe(inventoryStorageKey(productId));
    expect(inventoryStorageKey(ownerId)).not.toContain("session-token");
  });

  it.each([
    { ...complete, inventoryId: "../users" },
    { ...complete, body: { ...complete.body, idempotencyKey: "invalid" } },
    { ...complete, body: { ...complete.body, expectedVersion: -1 } },
    { ...complete, review: { ...review, lines: [{}] } },
    { ...create, body: { ...create.body, title: " " } },
    { ...create, body: { ...create.body, scope: "products", productIds: [productId, productId] } },
    { ...create, body: { ...create.body, scope: "categories", categoryIds: [] } },
    { ...count, body: { ...count.body, items: [{ productId, countedQuantity: -1 }] } },
    { ...count, body: { ...count.body, items: [{ productId, countedQuantity: "-1.0000" }] } },
    { ...count, body: { ...count.body, items: [{ productId, countedQuantity: "0.0000", justification: "x".repeat(601) }] } },
    { ...rebase, body: { ...rebase.body, productIds: [] } }
  ])("recusa recuperação com contrato inválido", (intent) => {
    expect(() => recoverInventoryIntent(JSON.stringify({ intent }))).toThrow("invalid-pending-inventory");
  });
});
