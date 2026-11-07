import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoticeInput, NotificationDTO } from "../../src/lib/notifications/types.ts";
import { getNotifications, getNotificationSummary, markAllNotificationsRead, markNotificationRead, noticeBody, noticeStorageKey, parseNotification, publishNotice, recoverStoredNotice } from "../../src/components/notifications/notifications-api.ts";
import { initialNotificationFilters, notificationHref, notificationQuery } from "../../src/components/notifications/notifications-meta.ts";

const id = "00000000-0000-4000-8000-000000000001";
const key = "00000000-0000-4000-8000-000000000002";
const timestamp = "2026-11-01T12:00:00.000Z";
const notification: NotificationDTO = { id, kind: "ADMIN_NOTICE", title: "Conferência amanhã", message: "Confira o seu setor.", createdAt: timestamp, readAt: null, href: null };
const intent: NoticeInput = { title: notification.title, message: notification.message, idempotencyKey: key };

beforeEach(() => { vi.stubGlobal("document", { cookie: "unrelated=ignored; prevision.csrf=csrf%20de%20teste" }); vi.stubGlobal("fetch", vi.fn()); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("alvos e filtros da central", () => {
  it.each([`/estoque?productId=${id}`, `/estoque?movementId=${id}`, `/inventarios?id=${id}`, "/estoque", "/inventarios"])("aceita o módulo interno %s", (value) => expect(notificationHref(value)).toBe(value));
  it.each(["https://bad.invalid", "//bad.invalid", "javascript:alert(1)", "/\\bad.invalid", "/usuarios", `/estoque?productId=${id}&redirect=https://bad.invalid`, "/estoque?search=%0a", null, {}])("recusa link fora dos módulos reconhecidos: %s", (value) => expect(notificationHref(value)).toBeNull());
  it("normaliza pesquisa e gera limites diários com o fuso do navegador", () => {
    const query = new URLSearchParams(notificationQuery({ ...initialNotificationFilters, search: "  Café  ", kind: "STOCK_LOW", read: "unread", from: "2026-11-01", to: "2026-11-02" }, 2));
    expect(query.get("page")).toBe("2"); expect(query.get("pageSize")).toBe("20"); expect(query.get("search")).toBe("Café"); expect(query.get("kind")).toBe("STOCK_LOW"); expect(query.get("read")).toBe("unread");
    expect(query.get("from")).toBe(new Date("2026-11-01T00:00:00").toISOString()); expect(query.get("to")).toBe(new Date("2026-11-02T23:59:59.999").toISOString());
  });
  it.each([{ from: "2026-11-02", to: "2026-11-01" }, { from: "2026-02-30" }, { to: "not-a-date" }, { read: "yes" }, { kind: "PRIVATE" }])("recusa filtro inválido", (invalid) => expect(() => notificationQuery({ ...initialNotificationFilters, ...invalid }, 1)).toThrow());
});
describe("respostas e marcação individual", () => {
  it("mantém apenas dados reconhecidos e remove um destino externo", () => {
    expect(parseNotification({ ...notification, href: "https://bad.invalid", userId: key, password: "private" })).toEqual(notification);
  });
  it("não confunde o total filtrado com a contagem global de não lidas", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ items: [notification], total: 1, unreadCount: 30, page: 1, pageSize: 20, totalPages: 1, asOf: timestamp }));
    const result = await getNotifications("/api/notifications?read=unread");
    expect(result.unreadCount).toBe(30); expect(result.total).toBe(1);
  });
  it.each([{ total: 1, unreadCount: 2, asOf: timestamp }, { total: -1, unreadCount: 0, asOf: timestamp }, { total: 1, unreadCount: 1, asOf: "invalid" }])("recusa resumo incoerente", async (body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body)); await expect(getNotificationSummary()).rejects.toThrow();
  });
  it("envia CSRF e não inclui identificador de outro usuário na leitura", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ ...notification, readAt: timestamp }));
    expect((await markNotificationRead(id)).readAt).toBe(timestamp);
    expect(fetch).toHaveBeenCalledWith(`/api/notifications/${id}/read`, expect.objectContaining({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", "X-Prevision-CSRF": "csrf de teste" }, body: "{}" }));
  });
  it("não assume leitura quando o retorno aponta outro registro ou não confirma readAt", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ ...notification, id: key, readAt: timestamp })).mockResolvedValueOnce(Response.json(notification));
    await expect(markNotificationRead(id)).rejects.toThrow(); await expect(markNotificationRead(id)).rejects.toThrow();
  });
  it("marca todas usando o corte apresentado, preservando novas notificações", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ markedCount: 7 }));
    expect(await markAllNotificationsRead(timestamp)).toEqual({ markedCount: 7 });
    expect(fetch).toHaveBeenCalledWith("/api/notifications/read-all", expect.objectContaining({ body: JSON.stringify({ through: timestamp }) }));
  });
  it("propaga rejeição segura do servidor e respeita cancelamento de consulta", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ message: "Entre novamente." }, { status: 401 }));
    await expect(getNotificationSummary()).rejects.toMatchObject({ status: 401, message: "Entre novamente." });
    const controller = new AbortController(); controller.abort();
    vi.mocked(fetch).mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    await expect(getNotificationSummary(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
describe("publicação administrativa com resposta incerta", () => {
  it("normaliza o título conforme o servidor antes de conferir a resposta", () => {
    expect(noticeBody({ ...intent, title: "  Conferência   amanhã  ", message: "  Confira o seu setor.  " })).toEqual(intent);
    expect(() => noticeBody({ ...intent, message: "Aviso\u0000inválido" })).toThrow();
  });
  it("repete o mesmo pedido após falha de rede e retorno 503, sem trocar chave", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(Response.json({ message: "Indisponível." }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ notification, replayed: true }));
    await expect(publishNotice(intent)).rejects.toMatchObject({ uncertain: true });
    await expect(publishNotice(intent)).rejects.toMatchObject({ uncertain: true });
    expect(await publishNotice(intent)).toEqual({ notification, replayed: true });
    for (const [url, options] of vi.mocked(fetch).mock.calls) {
      expect(url).toBe("/api/notifications/notices"); expect(options?.body).toBe(JSON.stringify(intent));
    }
  });
  it.each([{}, { notification: { ...notification, title: "Outro aviso" }, replayed: false }, { notification, replayed: "yes" }])("não assume sucesso sem confirmação completa", async (body) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(body)); await expect(publishNotice(intent)).rejects.toMatchObject({ uncertain: true });
  });
  it.each([400, 401, 403, 409, 429])("trata recusa HTTP %i como resposta definitiva deste pedido", async (status) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ message: "Pedido recusado." }, { status })); await expect(publishNotice(intent)).rejects.toMatchObject({ status, uncertain: false });
  });
  it("recupera somente o pedido reconhecido, com chave por conta", () => {
    expect(recoverStoredNotice(JSON.stringify({ input: { ...intent, extra: "omit" }, uncertain: true, password: "omit" }))).toEqual({ input: intent, uncertain: true });
    expect(noticeStorageKey(id)).not.toBe(noticeStorageKey(key));
  });
  it.each(["{}", "null", "bad-json", JSON.stringify({ input: { ...intent, idempotencyKey: "bad" }, uncertain: true }), JSON.stringify({ input: intent, uncertain: "yes" })])("recusa retomada inválida", (raw) => expect(() => recoverStoredNotice(raw)).toThrow());
});
