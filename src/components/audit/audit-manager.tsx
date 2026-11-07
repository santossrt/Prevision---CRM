"use client";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import type { AuditList, AuditOptions } from "@/lib/audit/types";
import { actionLabel, moduleLabel } from "@/lib/audit/labels";
import { Icon } from "@/components/ui/icon";
import { catalogError, catalogRequest, isCancelled } from "@/components/catalog/catalog-api";
import { formatCatalogDate } from "@/components/catalog/catalog-meta";
import { AuditDetail } from "./audit-detail";

const empty = { search: "", actorId: "", module: "", action: "", entityType: "", entityId: "", operationId: "", from: "", to: "" };
type Filters = typeof empty;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function AuditManager() {
  const id = useId();
  const [draft, setDraft] = useState<Filters>(empty);
  const [filters, setFilters] = useState<Filters>(empty);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditList | null>(null);
  const [options, setOptions] = useState<AuditOptions | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [error, setError] = useState("");
  const [filterError, setFilterError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [eventId, setEventId] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const query = useMemo(() => {
    const values = new URLSearchParams({ page: String(page), pageSize: "20" });
    for (const [key, value] of Object.entries(filters)) {
      if (!value.trim()) continue;
      if (key === "from") values.set(key, new Date(`${value}T00:00:00`).toISOString());
      else if (key === "to") values.set(key, new Date(`${value}T23:59:59.999`).toISOString());
      else values.set(key, value.trim());
    }
    return values.toString();
  }, [filters, page]);
  useEffect(() => {
    const controller = new AbortController();
    setOptionsError("");
    void catalogRequest<AuditOptions>("/api/audit/options", { signal: controller.signal }).then(setOptions)
      .catch((failure) => { if (!isCancelled(failure)) setOptionsError(catalogError(failure)); });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setData(null);
    void catalogRequest<AuditList>(`/api/audit?${query}`, { signal: controller.signal }).then((result) => {
      setData(result); if (result.totalPages && page > result.totalPages) setPage(result.totalPages);
    }).catch((failure) => { if (!isCancelled(failure)) setError(catalogError(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query, page, revision]);
  const update = (key: keyof Filters, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFilterError("");
    if (draft.from && draft.to && draft.from > draft.to) { setFilterError("A data inicial deve ser anterior ou igual à data final."); return; }
    if (draft.operationId.trim() && !uuid.test(draft.operationId.trim())) { setFilterError("Informe o identificador completo da operação."); return; }
    for (const date of [draft.from, draft.to]) {
      if (date && (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(new Date(`${date}T00:00:00`).getTime()))) { setFilterError("Informe datas válidas para a consulta."); return; }
    }
    setFilters({ ...draft }); setPage(1);
  }
  function clear() { setDraft(empty); setFilters(empty); setPage(1); setFilterError(""); }
  function operation(operationId: string) {
    const selected = { ...empty, operationId };
    setDraft(selected); setFilters(selected); setPage(1); setAdvanced(true); setEventId(null); setFilterError("");
  }
  const filtered = Object.values(filters).some(Boolean);
  return <>
    <form className="audit-filter-form" onSubmit={apply} aria-label="Filtros da auditoria">
      <div className="audit-search"><label className="sr-only" htmlFor={`${id}-search`}>Pesquisar atividades</label><input id={`${id}-search`} type="search" value={draft.search} maxLength={100} placeholder="Responsável, entidade ou identificação" onChange={(event) => update("search", event.target.value)} /></div>
      <div className="catalog-filters audit-filters"><div><label htmlFor={`${id}-module`}>Módulo</label><select id={`${id}-module`} value={draft.module} onChange={(event) => update("module", event.target.value)}><option value="">Todos os módulos</option>{options?.modules.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div><div><label htmlFor={`${id}-action`}>Ação</label><select id={`${id}-action`} value={draft.action} onChange={(event) => update("action", event.target.value)}><option value="">Todas as ações</option>{options?.actions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div><div><label htmlFor={`${id}-actor`}>Responsável</label><select id={`${id}-actor`} value={draft.actorId} onChange={(event) => update("actorId", event.target.value)}><option value="">Todos os responsáveis</option>{options?.actors.map((actor) => <option value={actor.id} key={actor.id}>{actor.name || actor.id}</option>)}</select></div><div><label htmlFor={`${id}-from`}>De</label><input id={`${id}-from`} type="date" value={draft.from} onChange={(event) => update("from", event.target.value)} /></div><div><label htmlFor={`${id}-to`}>Até</label><input id={`${id}-to`} type="date" value={draft.to} onChange={(event) => update("to", event.target.value)} /></div></div>
      <button type="button" className="text-link audit-advanced-toggle" aria-expanded={advanced} aria-controls={`${id}-advanced`} onClick={() => setAdvanced((value) => !value)}>{advanced ? "Recolher filtros de identificação" : "Filtrar por entidade ou operação"}</button>
      {advanced && <div id={`${id}-advanced`} className="catalog-filters audit-advanced"><div><label htmlFor={`${id}-entity-type`}>Tipo de entidade</label><select id={`${id}-entity-type`} value={draft.entityType} onChange={(event) => update("entityType", event.target.value)}><option value="">Todos os tipos</option>{options?.entityTypes.map((type) => <option value={type} key={type}>{type}</option>)}</select></div><div><label htmlFor={`${id}-entity-id`}>Identificação do registro</label><input id={`${id}-entity-id`} value={draft.entityId} maxLength={128} placeholder="Identificador completo" onChange={(event) => update("entityId", event.target.value)} /></div><div><label htmlFor={`${id}-operation`}>Identificação da operação</label><input id={`${id}-operation`} value={draft.operationId} maxLength={36} placeholder="Identificador completo da operação" onChange={(event) => update("operationId", event.target.value)} /></div></div>}
      <div className="audit-filter-actions"><button type="submit" className="button-primary">Aplicar filtros</button><button type="button" className="button-secondary" onClick={clear}>Limpar</button><button type="button" className="text-link" onClick={() => setRevision((value) => value + 1)}>Atualizar consulta</button></div>
      {filterError && <p className="form-message form-error" role="alert">{filterError}</p>}
      <p className="audit-filter-note">Os filtros são aplicados ao confirmar. O período usa o horário local deste dispositivo.</p>
    </form>
    {optionsError && <p className="form-message form-error catalog-notice" role="alert">Não foi possível carregar as opções de filtros. {optionsError}</p>}
    {error && <div className="form-message form-error catalog-notice" role="alert"><p>{error}</p><button type="button" className="text-link" onClick={() => setRevision((value) => value + 1)}>Tentar novamente</button></div>}
    <section className="management-panel catalog-panel" aria-labelledby={`${id}-title`} aria-busy={loading}><div className="panel-heading"><div><h2 id={`${id}-title`}>Histórico de atividades</h2><p>Ações e alterações registradas com data, responsável e operação.</p></div>{data && <span className="count-badge">{data.total} registros</span>}</div>
      {loading ? <div className="table-state" role="status"><span className="catalog-loader" /><p>Consultando as atividades…</p></div> : data?.items.length ? <div className="table-scroll"><table className="catalog-table audit-table"><thead><tr><th scope="col">Data / Responsável</th><th scope="col">Ação / Módulo</th><th scope="col">Registro afetado</th><th scope="col">Origem</th><th scope="col"><span className="sr-only">Ações</span></th></tr></thead><tbody>{data.items.map((event) => <tr key={event.id}><td><div className="catalog-contact-cell"><span>{formatCatalogDate(event.createdAt)}</span><small>{event.actor ? event.actor.name || "Usuário sem nome" : "Não identificado"}</small></div></td><td><div className="catalog-name-cell"><strong>{actionLabel(event.action)}</strong><span>{moduleLabel(event.module)}</span></div></td><td><div className="catalog-contact-cell"><span>{event.entityType}</span><small className="audit-identifier">{event.entityId || "Não identificado"}</small></div></td><td>{event.origin || "Não informada"}</td><td><button type="button" className="text-link" onClick={() => setEventId(event.id)}>Detalhes</button></td></tr>)}</tbody></table></div> : !error && <div className="table-state"><Icon name="shield" /><strong>{filtered ? "Nenhuma atividade encontrada" : "Nenhuma atividade registrada"}</strong><p>{filtered ? "Amplie o período ou ajuste os filtros da consulta." : "As ações auditadas aparecerão aqui conforme o uso do sistema."}</p>{filtered && <button type="button" className="text-link" onClick={clear}>Limpar filtros</button>}</div>}
      {data && data.total > 0 && <div className="catalog-pagination"><span>{(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} de {data.total} registros</span><div><button type="button" className="button-secondary" disabled={loading || page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</button><span>Página {data.page} de {Math.max(1, data.totalPages)}</span><button type="button" className="button-secondary" disabled={loading || page >= data.totalPages} onClick={() => setPage((value) => value + 1)}>Próxima</button></div></div>}
    </section>
    <p className="management-footnote"><Icon name="shield" />A consulta é restrita aos perfis autorizados. Os registros desta área são preservados e não podem ser alterados ou excluídos pela interface.</p>
    {eventId && <AuditDetail key={eventId} eventId={eventId} onClose={() => setEventId(null)} onOperation={operation} />}
  </>;
}
