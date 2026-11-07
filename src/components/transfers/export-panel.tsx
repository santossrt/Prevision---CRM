"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ReportKind, ReportPreviewDTO } from "@/lib/transfers/types";
import type { AuditOptions } from "@/lib/audit/types";
import { formatCatalogDate as date } from "@/components/catalog/catalog-meta";
import { Icon } from "@/components/ui/icon";
import { actionLabel, moduleLabel } from "@/lib/audit/labels";
import { buildReportFilters, filterLabels, initialReportForm, reportLabels, statusLabels, type ReportForm } from "./transfers-meta";
import { downloadTransfer, isCancelled, previewReport, transferError, transferRequest } from "./transfers-api";
import { PreviewValue } from "./preview-value";

interface SelectorOption { id: string; name: string; isActive?: boolean }
interface SelectorOptions { categories: SelectorOption[]; suppliers: SelectorOption[] }
const typeLabels: Record<string, string> = { ENTRY: "Entrada", EXIT: "Saída", POSITIVE_ADJUSTMENT: "Ajuste positivo", NEGATIVE_ADJUSTMENT: "Ajuste negativo", COMPENSATION: "Compensação" };

export function ExportPanel({ kinds }: { kinds: ReportKind[] }) {
  const id = useId();
  const [kind, setKind] = useState<ReportKind>(kinds[0]);
  const [form, setForm] = useState<ReportForm>(initialReportForm);
  const [options, setOptions] = useState<SelectorOptions | null>(null);
  const [auditOptions, setAuditOptions] = useState<AuditOptions | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [optionsRevision, setOptionsRevision] = useState(0);
  const [preview, setPreview] = useState<ReportPreviewDTO | null>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<"xlsx" | "pdf" | null>(null);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  const inFlight = useRef(false);
  const request = useRef<AbortController | null>(null);
  const productSource = ["products", "stock", "low_stock", "empty_stock"].includes(kind);
  const optionsPath = productSource ? kind === "products" ? "/api/catalog/options" : "/api/stock/options" : "";
  const movementSource = ["entries", "exits", "adjustments", "movements"].includes(kind);
  const analyticalSource = kind === "abc" || kind === "replenishment";
  const calendarSource = analyticalSource || kind === "indicators";
  useEffect(() => {
    const interval = window.setInterval(() => { if (!document.hidden) setClock(Date.now()); }, 15000);
    return () => window.clearInterval(interval);
  }, []);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!optionsPath) return;
    const controller = new AbortController(); setOptions(null); setOptionsError("");
    void transferRequest<SelectorOptions>(optionsPath, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setOptions(data); })
      .catch((failure) => { if (!isCancelled(failure)) setOptionsError(transferError(failure)); });
    return () => controller.abort();
  }, [optionsPath, optionsRevision]);
  useEffect(() => {
    if (kind !== "audit") return;
    const controller = new AbortController(); setOptionsError("");
    void transferRequest<AuditOptions>("/api/audit/options", { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setAuditOptions(data); })
      .catch((failure) => { if (!isCancelled(failure)) setOptionsError(transferError(failure)); });
    return () => controller.abort();
  }, [kind, optionsRevision]);
  function update(field: keyof ReportForm, value: string) { setForm((current) => ({ ...current, [field]: value })); setError(""); }
  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current) return;
    setError("");
    let filters: Record<string, string>;
    try { filters = buildReportFilters(kind, form); } catch (failure) { setError(transferError(failure)); return; }
    inFlight.current = true; setBusy(true);
    const controller = new AbortController(); request.current = controller;
    try { const result = await previewReport({ kind, filters }, controller.signal); if (!controller.signal.aborted) { setPreview(result); setPage(1); setClock(Date.now()); } }
    catch (failure) { if (!isCancelled(failure)) setError(transferError(failure)); }
    finally { inFlight.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  async function download(format: "xlsx" | "pdf") {
    if (!preview || downloading) return;
    if (new Date(preview.expiresAt).getTime() <= Date.now()) { setClock(Date.now()); setError("Esta prévia expirou. Confira novamente o relatório para gerar arquivos atualizados."); return; }
    setDownloading(format); setError("");
    try { await downloadTransfer(`/api/transfers/exports/${encodeURIComponent(preview.id)}/download?format=${format}`, format); }
    catch (failure) { setError(transferError(failure)); }
    finally { setDownloading(null); }
  }
  function displayFilter(key: string, value: string): string {
    if (key === "categoryId") return options?.categories.find((item) => item.id === value)?.name ?? value;
    if (key === "supplierId") return options?.suppliers.find((item) => item.id === value)?.name ?? value;
    if (key === "actorId") return auditOptions?.actors.find((item) => item.id === value)?.name || value;
    if (key === "module") return moduleLabel(value);
    if (key === "action") return actionLabel(value);
    if (key === "type") return typeLabels[value] ?? value;
    if (key === "status" || key === "stock") return statusLabels[value] ?? value;
    if (key === "from" || key === "to") return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value.split("-").reverse().join("/") : date(value);
    return value;
  }
  const expired = !!preview && new Date(preview.expiresAt).getTime() <= clock;
  const visible = preview?.rows.slice((page - 1) * 20, page * 20) ?? [];
  const totalPages = Math.max(1, Math.ceil((preview?.rows.length ?? 0) / 20));
  const field = (name: keyof ReportForm, label: string, inputProps: { maxLength?: number; placeholder?: string } = {}) => <div className="form-field"><label htmlFor={`${id}-${name}`}>{label}</label><input id={`${id}-${name}`} value={form[name]} disabled={busy} onChange={(event) => update(name, event.target.value)} {...inputProps} /></div>;

  return <>
    <section className="management-panel transfer-export-panel" aria-labelledby={`${id}-title`}><div className="transfer-section-heading"><div><p className="eyebrow">DADOS PARA CONSULTAR E COMPARTILHAR</p><h2 id={`${id}-title`}>Escolha o relatório e confira os dados</h2><p>Os arquivos usam os registros da prévia, com identificação do Prevision e data de geração.</p></div></div>
      <form className="catalog-form transfer-report-form" onSubmit={(event) => void generate(event)}>
        <div className="catalog-form-grid"><div className="form-field"><label htmlFor={`${id}-kind`}>Relatório</label><select id={`${id}-kind`} value={kind} disabled={busy || !!downloading} onChange={(event) => { setKind(event.target.value as ReportKind); setPreview(null); setError(""); }}>{kinds.map((value) => <option value={value} key={value}>{reportLabels[value]}</option>)}</select></div>{kind !== "indicators" && field("search", kind === "inventories" ? "Pesquisar título do inventário" : kind === "audit" ? "Pesquisar responsável, registro ou operação" : "Pesquisar produto, SKU ou código", { maxLength: 100 })}
          {analyticalSource && <><div className="form-field"><label htmlFor={`${id}-analysis-status`}>Situação do produto</label><select id={`${id}-analysis-status`} disabled={busy} value={form.productStatus} onChange={(event) => update("productStatus", event.target.value)}><option value="all">Ativos e inativos</option><option value="active">Somente ativos</option><option value="inactive">Somente inativos</option></select></div>{field("thresholdA", "Limite da classe A (%)", { maxLength: 6 })}{field("thresholdB", "Limite acumulado da classe B (%)", { maxLength: 6 })}{field("horizonDays", "Horizonte de reposição (dias)", { maxLength: 3 })}</>}
          {productSource && <><div className="form-field"><label htmlFor={`${id}-status`}>Situação do produto</label><select id={`${id}-status`} disabled={busy} value={form.productStatus} onChange={(event) => update("productStatus", event.target.value)}><option value="all">Ativos e inativos</option><option value="active">Somente ativos</option><option value="inactive">Somente inativos</option></select></div><div className="form-field"><label htmlFor={`${id}-categoryId`}>Categoria</label><select id={`${id}-categoryId`} disabled={busy || !options} value={form.categoryId} onChange={(event) => update("categoryId", event.target.value)}><option value="">Todas as categorias</option>{options?.categories.map((item) => <option value={item.id} key={item.id}>{item.name}{item.isActive === false ? " (inativa)" : ""}</option>)}</select></div><div className="form-field"><label htmlFor={`${id}-supplierId`}>Fornecedor padrão</label><select id={`${id}-supplierId`} disabled={busy || !options} value={form.supplierId} onChange={(event) => update("supplierId", event.target.value)}><option value="">Todos os fornecedores</option>{options?.suppliers.map((item) => <option value={item.id} key={item.id}>{item.name}{item.isActive === false ? " (inativo)" : ""}</option>)}</select></div>{(kind === "products" || kind === "stock") && <div className="form-field"><label htmlFor={`${id}-stock`}>Situação do estoque</label><select id={`${id}-stock`} value={form.stock} disabled={busy} onChange={(event) => update("stock", event.target.value)}><option value="all">Todas as situações</option><option value="empty">Sem estoque</option><option value="low">Estoque baixo</option><option value="normal">Acima do mínimo</option></select></div>}</>}
          {kind === "movements" && <div className="form-field"><label htmlFor={`${id}-type`}>Tipo de movimentação</label><select id={`${id}-type`} disabled={busy} value={form.type} onChange={(event) => update("type", event.target.value)}><option value="">Todos os tipos</option>{Object.entries(typeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>}
          {kind === "inventories" && <div className="form-field"><label htmlFor={`${id}-inventoryStatus`}>Situação do inventário</label><select id={`${id}-inventoryStatus`} disabled={busy} value={form.inventoryStatus} onChange={(event) => update("inventoryStatus", event.target.value)}><option value="all">Todas as situações</option><option value="OPEN">Abertos</option><option value="COMPLETED">Concluídos</option><option value="CANCELED">Cancelados</option></select></div>}
          {!productSource && <><div className="form-field"><label htmlFor={`${id}-from`}>De</label><input id={`${id}-from`} type="date" disabled={busy} value={form.from} onChange={(event) => update("from", event.target.value)} /></div><div className="form-field"><label htmlFor={`${id}-to`}>Até</label><input id={`${id}-to`} type="date" disabled={busy} value={form.to} onChange={(event) => update("to", event.target.value)} /></div></>}
          {kind === "audit" && <><div className="form-field"><label htmlFor={`${id}-actorId`}>Responsável</label><select id={`${id}-actorId`} disabled={busy || !auditOptions} value={form.actorId} onChange={(event) => update("actorId", event.target.value)}><option value="">Todos os responsáveis</option>{auditOptions?.actors.map((item) => <option value={item.id} key={item.id}>{item.name || item.id}</option>)}</select></div><div className="form-field"><label htmlFor={`${id}-module`}>Módulo</label><select id={`${id}-module`} disabled={busy || !auditOptions} value={form.module} onChange={(event) => update("module", event.target.value)}><option value="">Todos os módulos</option>{auditOptions?.modules.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></div><div className="form-field"><label htmlFor={`${id}-action`}>Ação</label><select id={`${id}-action`} disabled={busy || !auditOptions} value={form.action} onChange={(event) => update("action", event.target.value)}><option value="">Todas as ações</option>{auditOptions?.actions.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></div></>}
        </div>
        {(movementSource || kind === "inventories" || kind === "audit") && <details className="transfer-advanced"><summary>Filtros por identificador</summary><div className="catalog-form-grid">{movementSource && field("productId", "Produto (ID)", { maxLength: 36, placeholder: "Opcional" })}{kind === "inventories" && field("inventoryId", "Inventário (ID)", { maxLength: 36, placeholder: "Opcional" })}{kind === "audit" && <>{field("entityType", "Tipo de registro", { maxLength: 80 })}{field("entityId", "Registro (ID)", { maxLength: 128 })}{field("operationId", "Operação (ID)", { maxLength: 36 })}</>}</div></details>}
        {optionsError && <div className="form-message form-error" role="alert"><p>Não foi possível carregar algumas opções de filtro. {optionsError}</p><button type="button" className="text-link" onClick={() => setOptionsRevision((value) => value + 1)}>Tentar novamente</button></div>}
        <div className="transfer-report-submit"><p>Até 1.000 linhas por relatório. {calendarSource ? "Período de até 366 dias em America/Sao_Paulo. Deixe ambas as datas vazias para o período padrão. O saldo de referência continua sendo o atual." : kind === "inventories" ? "Cada produto conferido ocupa uma linha; o período considera a abertura do inventário." : movementSource ? "O período considera a data da operação, no horário local do dispositivo." : kind === "audit" ? "O período considera a data do registro da atividade." : "Os valores e quantidades serão conferidos no momento da geração da prévia."}</p><button type="submit" className="button-primary" disabled={busy || !!downloading}>{busy ? "Conferindo relatório…" : "Conferir relatório"}<Icon name="arrow-right" /></button></div>
      </form>
    </section>
    {error && <p className="form-message form-error catalog-notice" role="alert">{error}</p>}
    {preview && <section className="management-panel catalog-panel transfer-preview" aria-labelledby={`${id}-preview`}>
      <div className="panel-heading"><div><p className="eyebrow">PRÉVIA DO RELATÓRIO</p><h2 id={`${id}-preview`}>{preview.title}</h2><p>Gerado em {date(preview.generatedAt)} · {preview.generatedBy.name || "Usuário cadastrado"}</p></div><span className="count-badge">{preview.rowCount} linhas</span></div>
      {Object.keys(preview.filters).length > 0 && <dl className="transfer-applied-filters">{Object.entries(preview.filters).map(([key, value]) => <div key={key}><dt>{filterLabels[key] ?? (key === "inventoryId" ? "Inventário (ID)" : key)}</dt><dd>{displayFilter(key, value)}</dd></div>)}</dl>}
      <div className="transfer-download-bar"><div><strong>{expired ? "Esta prévia expirou" : "Arquivos fiéis à prévia apresentada"}</strong><p>{expired ? "Confira novamente o relatório para atualizar os dados e liberar o download." : `Disponível até ${date(preview.expiresAt)}. Para incluir novas alterações, confira o relatório novamente.`}</p></div><div><button type="button" className="button-secondary" disabled={expired || !!downloading || busy} onClick={() => void download("xlsx")}>{downloading === "xlsx" ? "Preparando Excel…" : "Baixar Excel"}</button><button type="button" className="button-primary" disabled={expired || !!downloading || busy} onClick={() => void download("pdf")}>{downloading === "pdf" ? "Preparando PDF…" : "Baixar PDF"}</button></div></div>
      {preview.warnings.length > 0 && <ul className="transfer-report-warnings">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {preview.rows.length ? <div className="table-scroll"><table className="catalog-table transfer-report-table" style={{ minWidth: Math.max(650, preview.columns.length * 130) }}><thead><tr>{preview.columns.map((column) => <th scope="col" key={column.key}>{column.label}</th>)}</tr></thead><tbody>{visible.map((row, index) => <tr key={(page - 1) * 20 + index}>{preview.columns.map((column) => <td key={column.key}><PreviewValue value={row[column.key]} /></td>)}</tr>)}</tbody></table></div> : <div className="table-state"><Icon name="chart" /><strong>Nenhum registro para estes filtros</strong><p>Os arquivos terão a identificação do relatório e seus cabeçalhos. Amplie os filtros para consultar outros registros.</p></div>}
      <div className="catalog-pagination"><span>{preview.rows.length ? `${(page - 1) * 20 + 1}–${Math.min(page * 20, preview.rows.length)} de ${preview.rows.length} linhas` : "Nenhuma linha"}</span><div><button className="button-secondary" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</button><span>{page} / {totalPages}</span><button className="button-secondary" type="button" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Próxima</button></div></div>
    </section>}
  </>;
}
