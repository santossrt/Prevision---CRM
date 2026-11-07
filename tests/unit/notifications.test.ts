import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../src/server/auth/identity.ts";
import { ApplicationError } from "../../src/server/errors/application-error.ts";
import { Prisma } from "../../src/generated/prisma/client.ts";
import { createAdministrativeNotice, getNotificationSummary, listNotifications, markAllNotificationsRead, markNotificationRead } from "../../src/server/notifications/service.ts";
import { notificationId, parseMarkAll, parseMarkRead, parseNotice, parseNotificationQuery } from "../../src/server/notifications/validation.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown>, principal: null as Principal | null }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));
vi.mock("../../src/server/auth/identity.ts", () => ({ identityInclude: { user: true }, principalFromSession: () => state.principal }));
const actorId = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const actor: Principal = { id: actorId, name: "Administrador", email: "user@example.invalid", role: "ADMINISTRATOR", sessionId, sessionVersion: 0, permissions: ["stock.read", "settings.manage"], googleLinked: false, hasPassword: true, googleAccessAllowed: false };
const record = { id, kind: "STOCK_EMPTY", title: "Produto sem estoque", message: "Café (0001) está sem estoque.", createdAt: "2026-11-01T12:00:00.000Z", entityType: "Product", entityId: id, actorId, readAt: null };
const notice = { title: "Reunião", message: "Mensagem interna aos usuários.", idempotencyKey: sessionId };

function fixture() {
  const tx = { loginSession: { findUnique: vi.fn().mockResolvedValue({ id: sessionId }) }, $queryRaw: vi.fn().mockResolvedValue([]), $executeRaw: vi.fn().mockResolvedValue(0), auditEvent: { create: vi.fn().mockResolvedValue({}) } };
  const database = { $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown, _options?: unknown) => work(tx)) };
  state.database = database;
  return { tx, database };
}
beforeEach(() => { state.principal = { ...actor, permissions: [...actor.permissions] }; });
const sqlCall = (call: unknown[]) => Prisma.sql(call[0] as TemplateStringsArray, ...call.slice(1));

describe("contratos de notificações", () => {
  it("normaliza período com fuso e paginação, mantendo o padrão de leitura", () => {
    expect(parseNotificationQuery(new URLSearchParams("from=2026-11-01T08%3A00%3A00-03%3A00&page=2"))).toMatchObject({ read: "all", from: "2026-11-01T11:00:00.000Z", page: 2, pageSize: 20 });
  });
  it.each(["read=unknown", "kind=UNKNOWN", "search=a&search=b", "from=2026-11-01", "from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z", "page=0", "pageSize=51", "userId=other", "__proto__=other"])("recusa filtros inválidos ou ambíguos: %s", (query) => {
    expect(() => parseNotificationQuery(new URLSearchParams(query))).toThrow(ApplicationError);
  });
  it("marcar todas usa apenas o corte temporal informado, limitado ao relógio do servidor", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    expect(parseMarkAll({ through: "2099-01-01T00:00:00Z" }, now)).toEqual(now);
    expect(parseMarkAll({ through: "2026-11-01T11:00:00Z" }, now).toISOString()).toBe("2026-11-01T11:00:00.000Z");
    expect(() => parseMarkAll({ through: now.toISOString(), userId: id })).toThrow();
  });
  it("leitura individual não aceita identidades ou datas fornecidas pelo cliente", () => {
    expect(() => parseMarkRead({ userId: id })).toThrow();
    expect(() => parseMarkRead({ readAt: "2026-11-01T12:00:00Z" })).toThrow();
    expect(() => parseMarkRead({})).not.toThrow();
    expect(() => notificationId("other")).toThrow();
  });
  it("aviso exige texto válido e chave única sem campos extras", () => {
    expect(parseNotice({ ...notice, title: "  Reunião   mensal " }).title).toBe("Reunião mensal");
    for (const value of [{ ...notice, message: " " }, { ...notice, title: "a".repeat(121) }, { ...notice, message: "a".repeat(2001) }, { ...notice, href: "https://bad.invalid" }, { ...notice, idempotencyKey: "wrong" }, { ...notice, message: "nul\0" }]) expect(() => parseNotice(value)).toThrow();
  });
});

describe("consulta autorizada e leitura individual", () => {
  it("sessão revogada impede inclusive contagens e leitura de conteúdo", async () => {
    const { tx } = fixture(); state.principal = null;
    await expect(getNotificationSummary(actor)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.$executeRaw.mock.calls[0][0].join(" ")).toContain("pg_advisory_xact_lock_shared");
  });
  it("permissões atuais substituem o actor antigo também para contagens", async () => {
    const { tx, database } = fixture(); state.principal = { ...actor, permissions: [] };
    tx.$queryRaw.mockResolvedValueOnce([{ total: 2, unreadCount: 1 }]);
    const result = await getNotificationSummary(actor);
    expect(result).toMatchObject({ total: 2, unreadCount: 1 });
    const sql = sqlCall(tx.$queryRaw.mock.calls[0]);
    expect(sql.text).toContain("required_permission IS NULL");
    expect(sql.values).not.toContain("stock.read");
    expect(database.$transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: "ReadCommitted" });
  });
  it("lista e contagens usam a mesma instrução e pesquisa literal parametrizada", async () => {
    const { tx } = fixture(); tx.$queryRaw.mockResolvedValueOnce([{ total: 1, unreadCount: 3, items: [record] }]);
    const result = await listNotifications(actor, new URLSearchParams("read=unread&search=100%25"));
    expect(result).toMatchObject({ total: 1, unreadCount: 3, totalPages: 1, items: [{ href: `/estoque?productId=${id}`, readAt: null }] });
    expect(result.items[0]).not.toHaveProperty("actorId");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = sqlCall(tx.$queryRaw.mock.calls[0]);
    expect(sql.text).toContain("WITH visible"); expect(sql.text).toContain('"readAt" IS NULL');
    expect(sql.values).toContain("%100!%%"); expect(sql.values).toContain("stock.read");
  });
  it("marca apenas o usuário autenticado e retorna o horário gravado no banco", async () => {
    const { tx } = fixture(); const readAt = new Date("2026-11-01T12:20:00Z");
    tx.$queryRaw.mockResolvedValueOnce([record]).mockResolvedValueOnce([{ readAt }]);
    const result = await markNotificationRead(actor, id, {});
    expect(result.readAt).toBe(readAt.toISOString());
    const insert = tx.$executeRaw.mock.calls[1];
    expect(insert[0].join(" ")).toContain("ON CONFLICT");
    expect(insert.slice(1)).toEqual([id, actorId]);
  });
  it("repetir leitura preserva sua data sem gravar outro comprovante", async () => {
    const { tx } = fixture(); tx.$queryRaw.mockResolvedValueOnce([{ ...record, readAt: "2026-11-01T12:10:00Z" }]);
    expect((await markNotificationRead(actor, id, {})).readAt).toBe("2026-11-01T12:10:00.000Z");
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1); // auth lock only
  });
  it("notificação invisível retorna não encontrada e não marca leitura", async () => {
    const { tx } = fixture();
    await expect(markNotificationRead(actor, id, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
  it("marcar todas restringe data, permissões atuais e usuário no INSERT SELECT", async () => {
    const { tx } = fixture(); tx.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(4);
    state.principal = { ...actor, permissions: [] };
    expect(await markAllNotificationsRead(actor, { through: "2026-11-01T12:00:00Z" })).toEqual({ markedCount: 4 });
    const query = sqlCall(tx.$executeRaw.mock.calls[1]);
    expect(query.text).toContain("required_permission IS NULL"); expect(query.text).toContain("created_at<=");
    expect(query.values).toContain(actorId); expect(query.values).not.toContain("stock.read");
    expect(query.values.some((value: unknown) => value instanceof Date && value.toISOString() === "2026-11-01T12:00:00.000Z")).toBe(true);
  });
});

describe("avisos administrativos", () => {
  it.each(["OPERATOR", "MANAGER"] as const)("perfil atual %s não publica mesmo com actor antigo de administrador", async (role) => {
    const { tx } = fixture(); state.principal = { ...actor, role };
    await expect(createAdministrativeNotice(actor, notice)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.$queryRaw).not.toHaveBeenCalled(); expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });
  it("administrador sem settings.manage também é recusado", async () => {
    const { tx } = fixture(); state.principal = { ...actor, permissions: ["stock.read"] };
    await expect(createAdministrativeNotice(actor, notice)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
  it("publica e audita metadados na mesma transação sem registrar o corpo do aviso", async () => {
    const { tx } = fixture();
    const result = await createAdministrativeNotice(actor, notice);
    expect(result).toMatchObject({ replayed: false, notification: { title: notice.title, message: notice.message, href: null, kind: "ADMIN_NOTICE" } });
    expect(tx.$executeRaw.mock.calls[0][0].join(" ")).toContain("pg_advisory_xact_lock(");
    const audit = tx.auditEvent.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ actorId, module: "SYSTEM", action: "CREATE", origin: "notifications.notice.create", newValues: { title: notice.title, kind: "ADMIN_NOTICE" } });
    expect(JSON.stringify(audit)).not.toContain(notice.message);
  });
  it("repetir a mesma chave e conteúdo retorna o aviso sem nova auditoria", async () => {
    const { tx } = fixture(); tx.$queryRaw.mockResolvedValueOnce([{ ...record, kind: "ADMIN_NOTICE", title: notice.title, message: notice.message, entityType: null, entityId: null }]);
    expect(await createAdministrativeNotice(actor, notice)).toMatchObject({ replayed: true, notification: { id } });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1); expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });
  it.each([{ actorId: id }, { title: "Outro título" }, { message: "Outro conteúdo" }, { kind: "STOCK_LOW" }])("não reutiliza identificação com ator ou conteúdo diferente", async (difference) => {
    const { tx } = fixture(); tx.$queryRaw.mockResolvedValueOnce([{ ...record, kind: "ADMIN_NOTICE", title: notice.title, message: notice.message, ...difference }]);
    await expect(createAdministrativeNotice(actor, notice)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });
});
