import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeAuditOrigin, sanitizeAuditSnapshot } from "../../src/server/audit/sanitize.ts";
import { parseAuditQuery } from "../../src/server/audit/validation.ts";
import { getAuditEvent, getAuditOptions, listAuditEvents } from "../../src/server/audit/service.ts";
import { ApplicationError } from "../../src/server/errors/application-error.ts";
import type { Principal } from "../../src/server/auth/identity.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown>, validateActor: vi.fn(), identity: vi.fn() }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: state.identity }));
vi.mock("../../src/server/authorization/guard.ts", async (original) => ({
  ...await original<typeof import("../../src/server/authorization/guard.ts")>(), assertActorInTransaction: state.validateActor
}));
const actorId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const operationId = "00000000-0000-4000-8000-000000000003";
const actor = { id: actorId, permissions: ["audit.read"] } as Principal;

function fixture() {
  const event = { id: eventId, actor: { id: actorId, name: "Responsável" }, action: "UPDATE", module: "PRODUCTS", entityType: "Product", entityId: eventId,
    operationId, createdAt: new Date("2026-10-31T12:00:00Z"), origin: "catalog", previousValues: { name: "Anterior", passwordHash: "hash-privado" }, newValues: { name: "Atual", token: "token-privado" } };
  const raw = vi.fn().mockResolvedValue([]);
  const tx = { $queryRaw: raw, auditEvent: { findUnique: vi.fn().mockResolvedValue(event), findMany: vi.fn().mockResolvedValue([event]) } };
  const database = { $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown, _options?: unknown) => work(tx)) };
  state.database = database;
  return { event, raw, tx, database };
}
beforeEach(() => { state.identity.mockReset().mockResolvedValue(undefined); state.validateActor.mockReset().mockResolvedValue(undefined); });

describe("exibição segura de snapshots de auditoria", () => {
  it("preserva campos públicos e remove credenciais aninhadas e campos desconhecidos", () => {
    const result = sanitizeAuditSnapshot({ name: "Público", passwordHash: "hash-secreto", token: "token-secreto", extra: "extra-privado",
      category: { name: "Categoria", clientSecret: "secret-privado" }, items: [{ productId: eventId, countedQuantity: "2.0000", authorization: "auth-privada" }] });
    expect(result).toMatchObject({ omitted: true, truncated: false, values: { name: "Público", category: { name: "Categoria" }, items: [{ productId: eventId, countedQuantity: "2.0000" }] } });
    expect(JSON.stringify(result)).not.toMatch(/hash-secreto|token-secreto|extra-privado|secret-privado|auth-privada/u);
  });
  it("permite flags de senha apenas booleanas e permissões declaradas", () => {
    expect(sanitizeAuditSnapshot({ passwordResetRequested: true, administrativeReset: true, passwordResetDeliveryFailed: "privado", permissions: ["audit.read", "secret-arbitrario", "stock.adjust"] }))
      .toMatchObject({ omitted: true, values: { passwordResetRequested: true, administrativeReset: true, permissions: ["audit.read", "stock.adjust"] } });
  });
  it("restringe listas de IDs e itens ao contrato conhecido", () => {
    const result = sanitizeAuditSnapshot({ productIds: [eventId, "senha-privada"], movementIds: [operationId], items: ["token-privado", { quantity: "0.0000" }] });
    expect(result).toMatchObject({ omitted: true, values: { productIds: [eventId], movementIds: [operationId], items: [{ quantity: "0.0000" }] } });
    expect(JSON.stringify(result)).not.toContain("privado");
  });
  it("não executa getters, toJSON ou chaves de protótipo", () => {
    const getter = vi.fn(() => "não executar");
    const value = JSON.parse('{"name":"Produto","__proto__":{"name":"segredo"},"constructor":{"name":"segredo"}}');
    Object.defineProperty(value, "notes", { enumerable: true, get: getter });
    value.toJSON = vi.fn(() => ({ name: "segredo" }));
    const result = sanitizeAuditSnapshot(value);
    expect(result).toMatchObject({ values: { name: "Produto" }, omitted: true });
    expect(getter).not.toHaveBeenCalled(); expect(value.toJSON).not.toHaveBeenCalled();
  });
  it("não executa getters em arrays", () => {
    const getter = vi.fn(() => ({ name: "segredo" }));
    const items = new Array(1);
    Object.defineProperty(items, "0", { get: getter });
    expect(sanitizeAuditSnapshot({ items })).toMatchObject({ omitted: true, values: { items: [] } });
    expect(getter).not.toHaveBeenCalled();
  });
  it("limita strings, listas e profundidade sem propagar ciclos", () => {
    const cyclic: Record<string, unknown> = { name: "n".repeat(1200), items: Array.from({ length: 60 }, () => ({ quantity: "1.0000" })) };
    cyclic.category = cyclic;
    const result = sanitizeAuditSnapshot(cyclic)!;
    const values = result.values as { name: string; items: unknown[] };
    expect(values.name).toHaveLength(1000); expect(values.items).toHaveLength(50); expect(result.truncated).toBe(true); expect(result.omitted).toBe(true);
    let nested: unknown = { name: "fim" };
    for (let depth = 0; depth < 10; depth++) nested = { category: nested };
    expect(sanitizeAuditSnapshot(nested)?.truncated).toBe(true);
  });
  it.each(["credencial-privada", 42, ["segredo"], true])("não exibe snapshots sem contexto de campos", (value) => {
    expect(sanitizeAuditSnapshot(value)).toEqual({ values: null, omitted: true, truncated: false });
  });
  it("aceita ausência de snapshot", () => { expect(sanitizeAuditSnapshot(null)).toBeNull(); expect(sanitizeAuditSnapshot(undefined)).toBeNull(); });
  it("omite origens arbitrárias que poderiam conter segredos", () => {
    expect(sanitizeAuditOrigin("inventory.complete")).toBe("inventory.complete");
    expect(sanitizeAuditOrigin("users.admin_password_reset.complete")).toBe("users.admin_password_reset.complete");
    expect(sanitizeAuditOrigin("127.0.0.1")).toBe("127.0.0.1");
    expect(sanitizeAuditOrigin("https://server/callback?token=privado")).toBeNull();
    expect(sanitizeAuditOrigin("Bearer privado")).toBeNull();
  });
});

describe("filtros de auditoria", () => {
  it("normaliza UUID, datas e paginação", () => {
    expect(parseAuditQuery(new URLSearchParams({ actorId, operationId, module: "STOCK", action: "STOCK_ENTRY", from: "2026-10-31T10:00:00-03:00", to: "2026-10-31T15:00:00Z", page: "2", pageSize: "10" })))
      .toMatchObject({ actorId, operationId, module: "STOCK", from: "2026-10-31T13:00:00.000Z", page: 2, pageSize: 10 });
  });
  it.each(["page=&page=2", "page=&page=", "search=a&search=b", "page=0", "page=1e2", "pageSize=101", "actorId=inválido", "operationId=x", "module=UNKNOWN", "action=UNKNOWN", "extra=secret", "from=2026-10-31", "from=2026-11-01T00:00:00Z&to=2026-10-31T00:00:00Z"])("recusa filtro inválido: %s", (query) => {
    expect(() => parseAuditQuery(new URLSearchParams(query))).toThrow(ApplicationError);
  });
});

describe("consulta restrita de auditoria", () => {
  it("recusa falta de audit.read antes de consultar banco ou validar filtros", async () => {
    const { database } = fixture();
    const denied = { ...actor, permissions: ["stock.read"] };
    await expect(listAuditEvents(denied, new URLSearchParams("page=bad"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getAuditEvent(denied, eventId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getAuditOptions(denied)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(database.$transaction).not.toHaveBeenCalled(); expect(state.identity).not.toHaveBeenCalled();
  });
  it("revalida sessão e permissão antes de ler registros", async () => {
    const { tx } = fixture();
    state.validateActor.mockRejectedValue(new ApplicationError("UNAUTHORIZED", "Entre novamente."));
    await expect(getAuditEvent(actor, eventId)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.auditEvent.findUnique).not.toHaveBeenCalled();
  });
  it("lista somente metadados e preserva ordem da paginação", async () => {
    const { raw, tx, database } = fixture();
    raw.mockResolvedValueOnce([{ total: 1 }]).mockResolvedValueOnce([{ id: eventId }]);
    const result = await listAuditEvents(actor, new URLSearchParams());
    expect(result.items).toHaveLength(1); expect(result.items[0]).not.toHaveProperty("previousValues"); expect(result.items[0]).not.toHaveProperty("newValues");
    expect(tx.auditEvent.findMany.mock.calls[0][0].select).not.toHaveProperty("previousValues");
    expect(database.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: "RepeatableRead" });
  });
  it("parametriza LIKE e identificadores sem interpolar texto do usuário no SQL", async () => {
    const { raw } = fixture();
    raw.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
    const term = "x%' OR 1=1 --_";
    await listAuditEvents(actor, new URLSearchParams({ search: term, operationId }));
    const strings = [...raw.mock.calls[0][0] as TemplateStringsArray];
    const parameters: unknown[] = [];
    const collect = (value: unknown) => {
      if (typeof value === "object" && value && "strings" in value && "values" in value) {
        const nested = value as { strings: string[]; values: unknown[] };
        strings.push(...nested.strings); nested.values.forEach(collect);
      } else parameters.push(value);
    };
    raw.mock.calls[0].slice(1).forEach(collect);
    expect(strings.join("")).not.toContain(term);
    expect(strings.join("")).not.toContain("a.origin");
    expect(parameters).toContain(operationId); expect(parameters).toContain("%x!%' OR 1=1 --!_%");
  });
  it("sanitiza snapshots no detalhe e não inclui e-mail no ator", async () => {
    fixture();
    const result = await getAuditEvent(actor, eventId);
    expect(result.previousValues).toMatchObject({ values: { name: "Anterior" }, omitted: true });
    expect(result.newValues).toMatchObject({ values: { name: "Atual" }, omitted: true });
    expect(result.actor).not.toHaveProperty("email"); expect(JSON.stringify(result)).not.toMatch(/hash-privado|token-privado/u);
  });
  it("trata identificador inválido e registro ausente", async () => {
    const { tx } = fixture();
    await expect(getAuditEvent(actor, "not-id")).rejects.toMatchObject({ code: "VALIDATION" });
    tx.auditEvent.findUnique.mockResolvedValueOnce(null);
    await expect(getAuditEvent(actor, eventId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("opções contêm somente nomes/IDs e valores declarados de ação/módulo", async () => {
    const { raw } = fixture();
    raw.mockResolvedValueOnce([{ id: actorId, name: "Responsável" }]).mockResolvedValueOnce([{ entityType: "Product" }]);
    const result = await getAuditOptions(actor);
    expect(result.actors).toEqual([{ id: actorId, name: "Responsável" }]);
    expect(result.modules).toContainEqual({ value: "STOCK", label: "Estoque" }); expect(result.entityTypes).toEqual(["Product"]);
  });
});
