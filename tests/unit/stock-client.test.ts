import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimatedBalance, estimatedTotal, inverse, normalizeDecimal } from "../../src/components/stock/stock-format.ts";
import { StockSubmissionError, submitStockIntent } from "../../src/components/stock/stock-api.ts";
import type { StockIntent } from "../../src/components/stock/stock-intent.ts";

describe("prévia decimal do estoque", () => {
  it.each([
    ["1.0000", "1.2350", "1.24"],
    ["1.0000", "1.2349", "1.23"],
    ["0.0001", "50.0000", "0.01"],
    ["0.0001", "49.9999", "0.00"],
    ["1.2345", "2.3456", "2.90"],
    ["-1.2345", "2.3456", "2.90"],
    ["99999999999999.9999", "0.0001", "10000000000.00"],
    ["99999999999999.9999", "99999999999999.9999", "9999999999999999980000000000.00"]
  ])("arredonda o total de %s × %s para %s sem ponto flutuante", (quantity, cost, total) => {
    expect(estimatedTotal(quantity, cost)).toBe(total);
  });

  it("preserva a menor unidade decimal em saldos próximos do limite", () => {
    expect(estimatedBalance("99999999999999.9998", "0.0001")).toBe("99999999999999.9999");
    expect(estimatedBalance("99999999999999.9999", "-0.0001")).toBe("99999999999999.9998");
    expect(estimatedBalance("0.0001", "-0.0001")).toBe("0.0000");
    expect(estimatedBalance("0.0000", "-0.0001")).toBe("-0.0001");
  });

  it("converte a entrada local e o inverso sem perder casas decimais", () => {
    expect(normalizeDecimal("0001,2345")).toBe("1.2345");
    expect(normalizeDecimal("99999999999999,9999")).toBe("99999999999999.9999");
    const quantity = "99999999999999.9999";
    expect(inverse(quantity)).toBe(`-${quantity}`);
    expect(inverse(inverse(quantity))).toBe(quantity);
  });
});

const movementId = "00000000-0000-4000-8000-000000000010";
const productId = "00000000-0000-4000-8000-000000000020";
const requestId = "00000000-0000-4000-8000-000000000030";

function movementIntent(): StockIntent {
  return {
    kind: "movement", body: {
      type: "EXIT", productId, quantity: "1.2345", unitPrice: "2.3456",
      occurredAt: "2026-10-31T12:00:00.000Z", idempotencyKey: requestId, notes: "Pedido de teste"
    }, review: {
      productName: "Produto de teste", sku: "TEST-CLIENT", unit: "UN", type: "EXIT",
      quantityDelta: "-1.2345", quantityBefore: "5.0000", unitCost: "1.0000", unitPrice: "2.3456",
      supplier: null, customer: null, occurredAt: "2026-10-31T12:00:00.000Z", justification: null, notes: "Pedido de teste"
    }
  };
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("document", { cookie: "other=value; prevision.csrf=csrf-local-test%2Bvalue" });
});
afterEach(() => vi.unstubAllGlobals());

describe("confirmação e retentativa do mesmo lançamento", () => {
  it("preserva corpo e chave após falha de rede e 503, até a confirmação 201", async () => {
    const intent = movementIntent();
    Object.freeze(intent.body);
    const original = JSON.stringify(intent.body);
    fetchMock.mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(Response.json({ message: "Operação indisponível." }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ movement: { id: movementId }, replayed: false }, { status: 201 }));

    await expect(submitStockIntent(intent)).rejects.toMatchObject({ uncertain: true });
    await expect(submitStockIntent(intent)).rejects.toMatchObject({ uncertain: true });
    await expect(submitStockIntent(intent)).resolves.toMatchObject({ movement: { id: movementId }, replayed: false });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe("/api/stock/movements");
      expect(options).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", body: original });
      expect(options?.headers).toEqual({ "Content-Type": "application/json", "X-Prevision-CSRF": "csrf-local-test+value" });
      expect(JSON.parse(String(options?.body)).idempotencyKey).toBe(requestId);
    }
    expect(JSON.stringify(intent.body)).toBe(original);
  });

  it("reconhece a resposta de replay sem trocar a identidade da operação", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ movement: { id: movementId }, replayed: true }));
    const result = await submitStockIntent(movementIntent());
    expect(result.replayed).toBe(true);
    expect(result.movement.id).toBe(movementId);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("mantém a mesma compensação e chave quando a resposta inicial se perde", async () => {
    const original = movementIntent();
    const intent: StockIntent = {
      kind: "compensation", movementId, body: { justification: "Corrigir lançamento de teste", idempotencyKey: requestId },
      review: { ...original.review, type: "COMPENSATION", quantityDelta: "1.2345", justification: "Corrigir lançamento de teste" }
    };
    Object.freeze(intent.body);
    fetchMock.mockRejectedValueOnce(new DOMException("request timed out", "TimeoutError"))
      .mockResolvedValueOnce(Response.json({ movement: { id: movementId }, replayed: true }));
    await expect(submitStockIntent(intent)).rejects.toMatchObject({ uncertain: true });
    await expect(submitStockIntent(intent)).resolves.toMatchObject({ replayed: true });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/stock/movements/${movementId}/compensate`, `/api/stock/movements/${movementId}/compensate`
    ]);
    expect(fetchMock.mock.calls.map(([, options]) => options?.body)).toEqual([JSON.stringify(intent.body), JSON.stringify(intent.body)]);
  });

  it.each([500, 502, 503, 504])("mantém HTTP %s como resultado incerto", async (status) => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: "Falha temporária." }, { status }));
    await expect(submitStockIntent(movementIntent())).rejects.toMatchObject({ uncertain: true, message: "Falha temporária." });
  });

  it.each([400, 401, 403, 404, 409, 429])("classifica HTTP %s como rejeição desta tentativa", async (status) => {
    fetchMock.mockResolvedValueOnce(Response.json({ message: "Solicitação rejeitada." }, { status }));
    await expect(submitStockIntent(movementIntent())).rejects.toMatchObject({ uncertain: false, message: "Solicitação rejeitada." });
    // A janela preserva uma incerteza anterior; este helper classifica somente
    // a tentativa atual, sem decidir se outro pedido pode ser iniciado.
  });

  it.each([null, {}, { movement: {} }, { movement: { id: movementId } }, { movement: { id: movementId }, replayed: "true" }])("não interpreta um HTTP 200 incompleto como confirmação", async (body) => {
    fetchMock.mockResolvedValueOnce(Response.json(body));
    await expect(submitStockIntent(movementIntent())).rejects.toMatchObject({ uncertain: true });
  });

  it("trata JSON ilegível com HTTP 200 como resultado incerto", async () => {
    fetchMock.mockResolvedValueOnce(new Response("resposta interrompida", { status: 200 }));
    const failure: unknown = await submitStockIntent(movementIntent()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StockSubmissionError);
    expect(failure).toMatchObject({ uncertain: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
