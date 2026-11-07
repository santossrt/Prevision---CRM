"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { AnalysisFilters } from "../../lib/analyses/types.ts";
import type { ReportKind, ReportPreviewDTO } from "../../lib/transfers/types.ts";
import { CatalogModal } from "../catalog/catalog-modal";
import { PreviewValue } from "../transfers/preview-value";
import { downloadTransfer, previewReport } from "../transfers/transfers-api";
import { analysisExportFilters, analysisDay, analysisTimestamp } from "./analyses-meta.ts";
import { analysisError } from "./analyses-api.ts";

export function AnalysisExport({ ownerId, kind, filters, onClose }: { ownerId: string; kind: "abc" | "replenishment"; filters: AnalysisFilters; onClose: () => void }) {
  const id = useId(); const [frozen] = useState(() => ({ ...filters }));
  const [preview, setPreview] = useState<ReportPreviewDTO | null>(null); const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<"xlsx" | "pdf" | null>(null); const [error, setError] = useState(""); const [page, setPage] = useState(1);
  const [clock, setClock] = useState(() => Date.now()); const inFlight = useRef(false); const controller = useRef<AbortController | null>(null);
  useEffect(() => { const interval = window.setInterval(() => setClock(Date.now()), 15000); return () => { window.clearInterval(interval); controller.current?.abort(); }; }, []);
  async function generate() {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError("");
    const request = new AbortController(); controller.current = request;
    const timer = window.setTimeout(() => request.abort(), 30000);
    try {
      const result = await previewReport({ kind: kind as ReportKind, filters: analysisExportFilters(frozen) }, request.signal);
      if (result.generatedBy.id !== ownerId || result.kind !== kind) throw new Error("A prévia não corresponde à análise solicitada. Atualize a página.");
      if (!request.signal.aborted) { setPreview(result); setPage(1); setClock(Date.now()); }
    } catch (failure) { setError(request.signal.aborted ? "A consulta demorou mais que o esperado. Gere a prévia novamente." : analysisError(failure)); }
    finally { window.clearTimeout(timer); inFlight.current = false; setBusy(false); }
  }
  async function download(format: "xlsx" | "pdf") {
    if (!preview || inFlight.current) return;
    if (new Date(preview.expiresAt).getTime() <= Date.now()) { setClock(Date.now()); setError("A prévia expirou. Gere outra antes de baixar."); return; }
    inFlight.current = true; setDownloading(format); setError("");
    try { await downloadTransfer(`/api/transfers/exports/${encodeURIComponent(preview.id)}/download?format=${format}`, format); }
    catch (failure) { setError(analysisError(failure)); }
    finally { inFlight.current = false; setDownloading(null); }
  }
  const expired = !!preview && new Date(preview.expiresAt).getTime() <= clock;
  const pages = Math.max(1, Math.ceil((preview?.rows.length ?? 0) / 20));
  return <CatalogModal title={kind === "abc" ? "Exportar Curva ABC" : "Exportar previsão de reposição"} caption="CONFERÊNCIA DO RELATÓRIO" wide busy={busy || !!downloading} onClose={onClose}>
    <p className="analysis-export-note">Será gerada uma nova consulta com os filtros abaixo. Confira a prévia antes de baixar: alterações feitas após a análise da tela podem aparecer no relatório.</p>
    <dl className="analysis-export-filters"><div><dt>Período em Brasília</dt><dd>{analysisDay(frozen.from)} a {analysisDay(frozen.to)}</dd></div><div><dt>Produtos</dt><dd>{frozen.status === "active" ? "Ativos" : frozen.status === "inactive" ? "Inativos" : "Ativos e inativos"}{frozen.search && ` · Pesquisa: ${frozen.search}`}</dd></div><div><dt>Limites ABC</dt><dd>A: {frozen.thresholdA.replace(".", ",")}% · B: {frozen.thresholdB.replace(".", ",")}%</dd></div><div><dt>Horizonte de cobertura</dt><dd>{frozen.horizonDays} dias</dd></div></dl>
    {error && <p className="form-message form-error" role="alert">{error}</p>}
    {preview && <section className="analysis-export-preview" aria-labelledby={`${id}-title`}><h3 id={`${id}-title`}>{preview.title}</h3><p>{preview.rowCount} produtos · Gerado em {analysisTimestamp(preview.generatedAt)} por {preview.generatedBy.name || "Usuário cadastrado"}.</p>
      {preview.warnings.length > 0 && <ul className="analysis-export-warnings">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {preview.rows.length ? <><div className="table-scroll"><table className="catalog-table analysis-export-table"><caption>Dados congelados na prévia para os arquivos Excel e PDF.</caption><thead><tr>{preview.columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>{preview.rows.slice((page - 1) * 20, page * 20).map((row, index) => <tr key={index}>{preview.columns.map((column) => <td key={column.key}><PreviewValue value={row[column.key]} /></td>)}</tr>)}</tbody></table></div><div className="analysis-pagination"><span>Página {page} de {pages}</span><div><button type="button" className="button-secondary" disabled={page === 1} onClick={() => setPage((value) => value - 1)}>Anterior</button><button type="button" className="button-secondary" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Próxima</button></div></div></> : <p className="analysis-empty">Nenhum produto corresponde aos filtros. O arquivo conterá a identificação e os cabeçalhos.</p>}
      <p className="analysis-export-note">{expired ? "Esta prévia expirou." : `Prévia disponível até ${analysisTimestamp(preview.expiresAt)}. Os downloads usam exatamente esses dados.`}</p>
    </section>}
    <div className="dialog-actions"><button type="button" className="button-secondary" disabled={busy || !!downloading} onClick={() => void generate()}>{busy ? "Gerando prévia…" : preview ? "Gerar nova prévia" : "Gerar prévia para conferir"}</button>{preview && <><button type="button" className="button-secondary" disabled={busy || !!downloading || expired} onClick={() => void download("xlsx")}>{downloading === "xlsx" ? "Preparando…" : "Baixar Excel"}</button><button type="button" className="button-primary" disabled={busy || !!downloading || expired} onClick={() => void download("pdf")}>{downloading === "pdf" ? "Preparando…" : "Baixar PDF"}</button></>}</div>
  </CatalogModal>;
}
