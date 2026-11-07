import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../src/generated/prisma/client.ts";
import type { Principal } from "../../src/server/auth/identity.ts";
import { verifyDatabaseIdentity } from "../../src/server/database/identity.ts";
import { getStockAlertSummary, listStockAlerts } from "../../src/server/stock/alerts.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown> }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));

const productId = "00000000-0000-4000-8000-000000000001";
const categoryId = "00000000-0000-4000-8000-000000000002";
const actor: Principal = {
  id: productId, name: "Operador", email: "operator@example.invalid", role: "OPERATOR",
  sessionId: categoryId, sessionVersion: 1, permissions: ["stock.read"],
  googleLinked: false, hasPassword: true, googleAccessAllowed: false
};
const record = {
  productId, name: "Produto", sku: "ZERO-1", barcode: "0000123456789", unitOfMeasure: "UN",
  quantity: "0.0000", minimumStock: "2.5000", kind: "EMPTY",
  openedAt: new Date("2026-10-31T14:00:00.000Z"), changedAt: new Date("2026-10-31T15:00:00.000Z")
};

function fixture() {
  const responses: unknown[] = [[{ empty: 3, low: 5, total: 8 }], [{ total: 1 }], [record]];
  const queries: { text: string; values: unknown[] }[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = Prisma.sql(strings, ...values);
      queries.push({ text: query.text, values: query.values });
      return responses.shift();
    })
  };
  const database = { $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown, _options?: unknown) => work(tx)) };
  state.database = database;
  return { tx, database, queries, responses };
}

beforeEach(() => { vi.mocked(verifyDatabaseIdentity).mockReset().mockResolvedValue(undefined); });

describe("consulta de alertas de estoque", () => {
  it("exige consulta de estoque antes de acessar o banco", async () => {
    const { database } = fixture();
    const denied = { ...actor, permissions: ["catalog.read"] };
    await expect(getStockAlertSummary(denied)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(listStockAlerts(denied, new URLSearchParams())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(verifyDatabaseIdentity).not.toHaveBeenCalled();
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("aceita operador autorizado sem conceder escrita ou exigir consulta de catálogo", async () => {
    const { database } = fixture();
    const summary = await getStockAlertSummary(actor);
    expect(summary).toEqual({ empty: 3, low: 5, total: 8 });
    expect(verifyDatabaseIdentity).toHaveBeenCalledOnce();
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 15000
    });
  });

  it("recusa consulta quando a identidade do banco é inválida", async () => {
    const { database } = fixture();
    vi.mocked(verifyDatabaseIdentity).mockRejectedValue(new Error("Ambiente incompatível"));
    await expect(getStockAlertSummary(actor)).rejects.toThrow("Ambiente incompatível");
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it("retorna apenas o contrato público e preserva zeros do código e decimais", async () => {
    fixture();
    const result = await listStockAlerts(actor, new URLSearchParams());
    expect(result).toEqual({
      items: [{ ...record, openedAt: record.openedAt.toISOString(), changedAt: record.changedAt.toISOString() }],
      total: 1, page: 1, pageSize: 20, totalPages: 1, summary: { empty: 3, low: 5, total: 8 }
    });
    expect(result.items[0]).not.toHaveProperty("resolvedAt");
    expect(result.items[0]).not.toHaveProperty("product");
  });

  it("lista só ocorrências ativas de produtos ativos e mantém resumo global", async () => {
    const { queries } = fixture();
    const result = await listStockAlerts(actor, new URLSearchParams({ kind: "LOW", categoryId, page: "2", pageSize: "5" }));
    expect(result.summary).toEqual({ empty: 3, low: 5, total: 8 });
    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 5, totalPages: 1 });
    for (const query of queries) {
      expect(query.text).toContain("a.resolved_at IS NULL");
      expect(query.text).toContain("p.is_active");
      expect(query.text).toContain("JOIN stock_balances");
    }
    expect(queries[0].values).toEqual([]);
    expect(queries[1].values).toEqual(["LOW", categoryId]);
    expect(queries[2].values).toEqual(["LOW", categoryId, 5, 5]);
    expect(queries[2].text).toContain("ORDER BY a.changed_at DESC, a.product_id ASC");
  });

  it("parametriza e escapa caracteres especiais na busca", async () => {
    const { queries } = fixture();
    const search = "_50%! ' OR 1=1 --";
    await listStockAlerts(actor, new URLSearchParams({ search }));
    const query = queries[2];
    expect(query.text).not.toContain(search);
    expect(query.values.slice(0, 3)).toEqual(Array(3).fill("%!_50!%!! ' OR 1=1 --%"));
    expect(query.text.match(/ILIKE/g)).toHaveLength(3);
  });

  it("mantém precisão de Decimal18,4 até seu limite", async () => {
    const { responses } = fixture();
    responses[2] = [{ ...record, kind: "LOW", quantity: "99999999999999.9998", minimumStock: "99999999999999.9999" }];
    const result = await listStockAlerts(actor, new URLSearchParams());
    expect(result.items[0]).toMatchObject({ quantity: "99999999999999.9998", minimumStock: "99999999999999.9999" });
  });

  it("retorna página vazia e totais zero sem valores indefinidos", async () => {
    const { responses } = fixture();
    responses.splice(0, responses.length, [{ empty: 0, low: 0, total: 0 }], [{ total: 0 }], []);
    expect(await listStockAlerts(actor, new URLSearchParams())).toEqual({
      items: [], total: 0, page: 1, pageSize: 20, totalPages: 0, summary: { empty: 0, low: 0, total: 0 }
    });
  });

  it.each([
    "page=0", "page=1.5", "pageSize=101", "kind=all", "kind=empty", "categoryId=invalid",
    "page=1&page=2", "page=&page=2", "page=&page=", "kind=LOW&kind=EMPTY", "unknown=1"
  ])("recusa filtros inválidos antes da transação: %s", async (query) => {
    const { database } = fixture();
    await expect(listStockAlerts(actor, new URLSearchParams(query))).rejects.toMatchObject({ code: "VALIDATION" });
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});
