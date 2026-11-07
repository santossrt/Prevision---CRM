"use client";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { NotificationSummary, NoticeResult } from "@/lib/notifications/types";
import { notificationKinds } from "@/lib/notifications/types";
import { CatalogModal } from "@/components/catalog/catalog-modal";
import { formatCatalogDate } from "@/components/catalog/catalog-meta";
import { Icon } from "@/components/ui/icon";
import { getNotifications, markAllNotificationsRead, markNotificationRead, notificationError } from "./notifications-api.ts";
import { initialNotificationFilters, notificationLabels, notificationQuery, type NotificationFilters } from "./notifications-meta.ts";
import { NotificationCard } from "./notification-card.tsx";
import { NoticeComposer } from "./notice-composer.tsx";
import { useNotifications } from "./use-notifications.ts";

export function NotificationsManager({ ownerId, canPublish }: { ownerId: string; canPublish: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState<NotificationFilters>(initialNotificationFilters);
  const [filters, setFilters] = useState<NotificationFilters>(initialNotificationFilters);
  const [page, setPage] = useState(1);
  const [filterError, setFilterError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingId, setPendingId] = useState("");
  const pending = useRef(false);
  const [markAll, setMarkAll] = useState<NotificationSummary | null>(null);
  const [composing, setComposing] = useState(false);
  const query = useMemo(() => notificationQuery(filters, page), [filters, page]);
  const load = useCallback((signal: AbortSignal) => getNotifications(`/api/notifications?${query}`, signal), [query]);
  const { data, loading, error, refresh } = useNotifications(`${ownerId}:${query}`, load);
  const busy = !!pendingId;
  useEffect(() => { if (data && page > Math.max(1, data.totalPages)) setPage(Math.max(1, data.totalPages)); }, [data, page]);
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFilterError("");
    try { notificationQuery(draft, 1); setFilters({ ...draft }); setPage(1); }
    catch (failure) { setFilterError(notificationError(failure)); }
  }
  function clear() { setDraft(initialNotificationFilters); setFilters(initialNotificationFilters); setPage(1); setFilterError(""); }
  function changed(text: string) { setNotice(text); refresh(); window.dispatchEvent(new Event("prevision:notifications-changed")); }
  async function readOne(notificationId: string) {
    if (pending.current) return;
    pending.current = true; setPendingId(notificationId); setActionError(""); setNotice("");
    try { await markNotificationRead(notificationId); changed("Notificação marcada como lida para sua conta."); }
    catch (failure) { setActionError(notificationError(failure)); }
    finally { pending.current = false; setPendingId(""); }
  }
  async function readAll() {
    if (!markAll || pending.current) return;
    pending.current = true; setPendingId("all"); setActionError(""); setNotice("");
    try {
      const result = await markAllNotificationsRead(markAll.asOf);
      setMarkAll(null); changed(`${result.markedCount} ${result.markedCount === 1 ? "notificação marcada como lida" : "notificações marcadas como lidas"} para sua conta.`);
    } catch (failure) { setActionError(notificationError(failure)); }
    finally { pending.current = false; setPendingId(""); }
  }
  function published(result: NoticeResult) { setComposing(false); changed(result.replayed ? "Publicação conferida: o aviso já estava registrado e não foi duplicado." : "Aviso administrativo publicado para a equipe."); }
  const update = (key: keyof NotificationFilters, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  return <>
    <div className="notification-summary"><div><span className="notification-summary-icon"><Icon name="layers" /></span><div><strong>{data ? data.unreadCount : "—"}</strong><span>não lidas para você</span></div></div><p>A leitura é individual. Os avisos disponíveis acompanham suas permissões atuais.</p>{canPublish && <button type="button" className="button-primary" onClick={() => setComposing(true)}>Novo aviso</button>}</div>
    <section className="management-panel notification-panel" aria-labelledby={`${id}-history`}>
      <div className="notification-panel-heading"><div><h2 id={`${id}-history`}>Seu histórico de notificações</h2><p>Consulte os acontecimentos e abra o módulo relacionado quando precisar.</p></div><button type="button" className="button-secondary" disabled={busy || loading || !!error || !data?.unreadCount} onClick={() => { if (data) { setActionError(""); setMarkAll({ total: data.total, unreadCount: data.unreadCount, asOf: data.asOf }); } }}>Marcar todas como lidas</button></div>
      <form className="notification-filter-form" onSubmit={apply} aria-label="Filtros das notificações">
        <div className="notification-filter-search"><label htmlFor={`${id}-search`}>Pesquisar</label><input id={`${id}-search`} type="search" maxLength={100} placeholder="Título ou mensagem" value={draft.search} onChange={(event) => update("search", event.target.value)} /></div>
        <div><label htmlFor={`${id}-read`}>Leitura</label><select id={`${id}-read`} value={draft.read} onChange={(event) => update("read", event.target.value)}><option value="all">Todas</option><option value="unread">Não lidas</option><option value="read">Lidas</option></select></div>
        <div><label htmlFor={`${id}-kind`}>Tipo</label><select id={`${id}-kind`} value={draft.kind} onChange={(event) => update("kind", event.target.value)}><option value="">Todos os tipos</option>{notificationKinds.map((kind) => <option key={kind} value={kind}>{notificationLabels[kind]}</option>)}</select></div>
        <div><label htmlFor={`${id}-from`}>De</label><input id={`${id}-from`} type="date" value={draft.from} onChange={(event) => update("from", event.target.value)} /></div>
        <div><label htmlFor={`${id}-to`}>Até</label><input id={`${id}-to`} type="date" value={draft.to} onChange={(event) => update("to", event.target.value)} /></div>
        <div className="notification-filter-actions"><button type="submit" className="button-primary">Filtrar</button><button type="button" className="button-secondary" onClick={clear}>Limpar</button><button type="button" className="text-link" disabled={loading} onClick={refresh}>Atualizar</button></div>
      </form>
      {filterError && <p className="form-message form-error" role="alert">{filterError}</p>}
      {notice && <p className="form-message form-success" role="status">{notice}</p>}
      {actionError && !markAll && <p className="form-message form-error" role="alert">{actionError}</p>}
      {error && <div className="form-message form-error" role="alert"><p>{error}</p><button type="button" className="text-link" onClick={refresh}>Tentar novamente</button></div>}
      {loading && <p className="notification-loading" role="status">Atualizando notificações…</p>}
      {data && <>
        <div className="notification-results-meta"><span>{data.total} {data.total === 1 ? "notificação encontrada" : "notificações encontradas"}</span><small>Consulta em {formatCatalogDate(data.asOf)}</small></div>
        {data.items.length ? <ul className="notification-list" aria-busy={loading}>{data.items.map((item) => <NotificationCard key={item.id} notification={item} disabled={busy} busy={pendingId === item.id} onRead={(notificationId) => void readOne(notificationId)} />)}</ul> : <div className="notification-empty"><Icon name="check" /><strong>{filters.read === "unread" ? "Nenhuma notificação não lida nesta consulta" : "Nenhuma notificação para estes filtros"}</strong><p>Os próximos acontecimentos aparecerão aqui conforme suas permissões.</p></div>}
        {data.totalPages > 0 && <nav className="notification-pagination" aria-label="Paginação das notificações"><span>Página {page} de {data.totalPages}</span><div><button type="button" className="button-secondary" disabled={loading || page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Anterior</button><button type="button" className="button-secondary" disabled={loading || page >= data.totalPages} onClick={() => setPage((current) => current + 1)}>Próxima</button></div></nav>}
      </>}
    </section>
    <p className="management-footnote notification-footnote"><Icon name="shield" />O histórico começa com a ativação da central. Marcar uma notificação como lida mantém seu registro e não altera produtos, movimentos ou inventários.</p>
    {markAll && <CatalogModal title="Marcar todas como lidas" caption="SUA LEITURA INDIVIDUAL" busy={busy} onClose={() => setMarkAll(null)}><p className="notification-dialog-note">Marcar como lidas as notificações disponíveis para sua conta até <strong>{formatCatalogDate(markAll.asOf)}</strong>?</p><p className="notification-dialog-note">A ação inclui os outros filtros do histórico. Avisos recebidos depois desse horário continuarão não lidos.</p>{actionError && <p className="form-message form-error" role="alert">{actionError}</p>}<div className="dialog-actions"><button type="button" className="button-secondary" disabled={busy} onClick={() => setMarkAll(null)}>Cancelar</button><button type="button" className="button-primary" disabled={busy} onClick={() => void readAll()}>{busy ? "Marcando…" : "Marcar como lidas"}</button></div></CatalogModal>}
    {composing && <NoticeComposer key={ownerId} ownerId={ownerId} onClose={() => setComposing(false)} onPublished={published} />}
  </>;
}
