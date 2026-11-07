"use client";
import { useEffect, useId, useState, type FormEvent } from "react";
import type { AnalysisFilters } from "../../lib/analyses/types.ts";
import { Icon } from "../ui/icon";
import { analysisDay, analysisFilters, analysisPreset, analysisQuery, analysisTimestamp, analysisToday, emptyAnalysisForm, type AnalysisForm } from "./analyses-meta.ts";
import { analysisError } from "./analyses-api.ts";
import { useAnalysis } from "./use-analysis.ts";
import { AbcPanel } from "./abc-panel.tsx";
import { ReplenishmentPanel } from "./replenishment-panel.tsx";
import { AnalysisExport } from "./analysis-export.tsx";

type Tab = "abc" | "replenishment";
export function AnalysesManager({ ownerId }: { ownerId: string }) {
  const id = useId(); const [draft, setDraft] = useState<AnalysisForm>(emptyAnalysisForm); const [query, setQuery] = useState(""); const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("abc"); const [filterError, setFilterError] = useState("");
  const [exporting, setExporting] = useState<{ kind: Tab; filters: AnalysisFilters } | null>(null);
  const { data, loading, error, refresh } = useAnalysis(ownerId, query, ready);
  useEffect(() => { const form = analysisPreset(); setDraft(form); setQuery(analysisQuery(analysisFilters(form))); setReady(true); }, []);
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFilterError("");
    try { const next = analysisQuery(analysisFilters(draft)); if (next === query) refresh(); else setQuery(next); }
    catch (failure) { setFilterError(analysisError(failure)); }
  }
  function reset() { const form = analysisPreset(); setDraft(form); setQuery(analysisQuery(analysisFilters(form))); setFilterError(""); refresh(); }
  function update(key: keyof AnalysisForm, value: string) { setDraft((previous) => ({ ...previous, [key]: value })); }
  function chooseTab(value: Tab, focus = false) { setTab(value); if (focus) document.getElementById(`${id}-${value}-tab`)?.focus(); }
  return <div className="analyses-manager">
    <form className="management-panel analysis-filter-form" onSubmit={apply} aria-label="Filtros e critérios das análises"><div className="analysis-filter-heading"><span className="module-icon"><Icon name="forecast" /></span><div><h2>Período e critérios</h2><p>Datas no calendário de Brasília · America/Sao_Paulo. Até 1.000 produtos por consulta completa.</p></div></div><div className="analysis-filter-grid">
      <div className="form-field"><label htmlFor={`${id}-from`}>De</label><input id={`${id}-from`} type="date" required max={ready ? analysisToday() : undefined} value={draft.from} onChange={(event) => update("from", event.target.value)} /></div><div className="form-field"><label htmlFor={`${id}-to`}>Até</label><input id={`${id}-to`} type="date" required max={ready ? analysisToday() : undefined} value={draft.to} onChange={(event) => update("to", event.target.value)} /></div>
      <div className="form-field analysis-filter-search"><label htmlFor={`${id}-search`}>Pesquisar produto</label><input id={`${id}-search`} type="search" maxLength={100} placeholder="Nome, SKU ou código de barras" value={draft.search} onChange={(event) => update("search", event.target.value)} /></div><div className="form-field"><label htmlFor={`${id}-status`}>Situação do cadastro</label><select id={`${id}-status`} value={draft.status} onChange={(event) => update("status", event.target.value)}><option value="all">Ativos e inativos</option><option value="active">Somente ativos</option><option value="inactive">Somente inativos</option></select></div>
      <div className="form-field"><label htmlFor={`${id}-a`}>Limite acumulado de A (%)</label><input id={`${id}-a`} inputMode="decimal" required maxLength={5} value={draft.thresholdA} onChange={(event) => update("thresholdA", event.target.value)} /></div><div className="form-field"><label htmlFor={`${id}-b`}>Limite acumulado de B (%)</label><input id={`${id}-b`} inputMode="decimal" required maxLength={5} value={draft.thresholdB} onChange={(event) => update("thresholdB", event.target.value)} /></div><div className="form-field"><label htmlFor={`${id}-horizon`}>Horizonte de cobertura (dias)</label><input id={`${id}-horizon`} type="number" required min={1} max={365} step={1} value={draft.horizonDays} onChange={(event) => update("horizonDays", event.target.value)} /></div>
    </div><div className="analysis-filter-actions"><p>Período de até 366 dias. Limites ABC: 0 &lt; A &lt; B &lt; 100%. Consulte para aplicar alterações.</p><div><button type="button" className="button-secondary" disabled={!ready} onClick={reset}>Padrão de 90 dias</button><button className="button-primary" type="submit" disabled={!ready}>Consultar<Icon name="arrow-right" /></button></div></div></form>
    {filterError && <p className="form-message form-error" role="alert">{filterError}</p>}
    <div className="catalog-tabs analysis-tabs" role="tablist" aria-label="Análises de estoque">{(["abc", "replenishment"] as const).map((value) => <button type="button" key={value} role="tab" id={`${id}-${value}-tab`} aria-controls={`${id}-${value}-panel`} aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => chooseTab(value)} onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); chooseTab(event.key === "Home" ? "abc" : event.key === "End" ? "replenishment" : value === "abc" ? "replenishment" : "abc", true); } }}><Icon name={value === "abc" ? "chart" : "forecast"} />{value === "abc" ? "Curva ABC" : "Previsão de reposição"}</button>)}</div>
    {error && <div className="form-message form-error analysis-error" role="alert"><p>{error}</p>{data && <p>Os dados abaixo pertencem à última consulta concluída.</p>}<button className="text-link" type="button" onClick={refresh}>Tentar novamente</button></div>}
    {loading && <p className="analysis-loading" role="status"><span className="catalog-loader" />{data ? "Atualizando análise…" : "Consultando consumo, saldo e parâmetros…"}</p>}
    {data && <><div className="analysis-query-meta"><div><strong>{analysisDay(data.filters.from)} a {analysisDay(data.filters.to)}</strong><span>Consulta em {analysisTimestamp(data.generatedAt)} · Brasília</span></div><div><button type="button" className="text-link" disabled={loading} onClick={refresh}>Atualizar</button><button type="button" className="button-secondary" disabled={loading || !!error} onClick={() => setExporting({ kind: tab, filters: { ...data.filters } })}>Exportar esta análise<Icon name="arrow-right" /></button></div></div>
      <section id={`${id}-abc-panel`} role="tabpanel" aria-labelledby={`${id}-abc-tab`} hidden={tab !== "abc"} aria-busy={loading}><AbcPanel data={data} /></section><section id={`${id}-replenishment-panel`} role="tabpanel" aria-labelledby={`${id}-replenishment-tab`} hidden={tab !== "replenishment"} aria-busy={loading}><ReplenishmentPanel data={data} /></section>
      <section className="analysis-method-notes" aria-labelledby={`${id}-notes-title`}><Icon name="shield" /><div><h2 id={`${id}-notes-title`}>Como interpretar esta análise</h2><ul>{data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div></section>
    </>}
    {exporting && <AnalysisExport key={`${ownerId}:${exporting.kind}`} ownerId={ownerId} kind={exporting.kind} filters={exporting.filters} onClose={() => setExporting(null)} />}
  </div>;
}
