"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import type { ImportPreviewDTO, ImportResult } from "@/lib/transfers/types";
import { Icon } from "@/components/ui/icon";
import { formatCatalogDate as date } from "@/components/catalog/catalog-meta";
import { ImportConfirmation } from "./import-confirmation";
import { PreviewValue } from "./preview-value";
import { downloadTransfer, importStorageKey, isCancelled, recoverStoredImport, transferError, transferRequest, uploadImport, validateImportFile, type ImportPending, type StoredImport } from "./transfers-api";

export function ImportPanel({ ownerId }: { ownerId: string }) {
  const id = useId();
  const storageKey = importStorageKey(ownerId);
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRequest = useRef<AbortController | null>(null);
  const restoreRequest = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewDTO | null>(null);
  const [pending, setPending] = useState<ImportPending | null>(null);
  const [pendingSubmitted, setPendingSubmitted] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState(1);
  const [templateBusy, setTemplateBusy] = useState<"csv" | "xlsx" | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const inFlight = useRef(false);

  function store(value: StoredImport) { sessionStorage.setItem(storageKey, JSON.stringify(value)); }
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const stored = recoverStoredImport(raw); setResumeId(stored.previewId);
        if (stored.pending) { setPending(stored.pending); setPendingSubmitted(true); setConfirmationOpen(true); }
      } else setLoading(false);
    } catch { setRecoveryError("Não foi possível recuperar o registro de uma possível importação pendente. Confira os produtos cadastrados antes de iniciar outro arquivo nesta aba."); setLoading(false); }
    setRecoveryReady(true);
  }, [storageKey]);
  useEffect(() => {
    if (!resumeId) return;
    const controller = new AbortController(); restoreRequest.current = controller; setLoading(true); setError("");
    void transferRequest<ImportPreviewDTO>(`/api/transfers/imports/${encodeURIComponent(resumeId)}`, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      setPreview(result); setPage(1);
      if (result.status === "COMPLETED") { setPending(null); setPendingSubmitted(false); setConfirmationOpen(false); try { store({ previewId: result.id }); } catch { /* the completed key remains safe to replay */ } }
    }).catch((failure) => { if (!isCancelled(failure)) setError(transferError(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); if (restoreRequest.current === controller) restoreRequest.current = null; };
    // storageKey identifies the account; store writes only server job identifiers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId, refresh, storageKey]);
  useEffect(() => () => uploadRequest.current?.abort(), []);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!file || inFlight.current || pending || loading) return;
    setError(""); setNotice("");
    try { validateImportFile(file); } catch (failure) { setError(transferError(failure)); return; }
    inFlight.current = true; setBusy(true);
    const controller = new AbortController(); uploadRequest.current = controller;
    try {
      const result = await uploadImport(file, controller.signal);
      setPreview(result); setPage(1); setResumeId(null);
      try { store({ previewId: result.id }); } catch { setNotice("A prévia está disponível nesta tela. O navegador precisa permitir o armazenamento desta página antes da confirmação."); }
      if (result.status === "COMPLETED") setNotice("Este arquivo já foi aplicado anteriormente. Os produtos não foram cadastrados novamente.");
      else if (result.errorCount) setNotice("O arquivo foi conferido. Corrija as linhas indicadas e envie a versão corrigida para gerar outra prévia.");
      else setNotice("Prévia pronta. Confira os dados antes de confirmar o cadastro.");
      setFile(null); if (inputRef.current) inputRef.current.value = "";
    } catch (failure) { if (!isCancelled(failure)) setError(transferError(failure)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function template(format: "csv" | "xlsx") {
    setTemplateBusy(format); setError("");
    try { await downloadTransfer(`/api/transfers/imports/template?format=${format}`, format); }
    catch (failure) { setError(transferError(failure)); }
    finally { setTemplateBusy(null); }
  }
  function beginConfirmation() {
    if (!preview?.canConfirm || pending || loading) return;
    if (new Date(preview.expiresAt).getTime() <= Date.now()) { setPreview({ ...preview, status: "EXPIRED", canConfirm: false }); setNotice("A prévia expirou. Envie o arquivo novamente para conferir os dados atuais."); return; }
    setPending({ importId: preview.id, idempotencyKey: crypto.randomUUID(), fileName: preview.fileName, rowCount: preview.rowCount });
    setPendingSubmitted(false); setConfirmationOpen(true);
  }
  function clearPending() {
    setPendingSubmitted(false);
    try { if (preview) store({ previewId: preview.id }); else sessionStorage.removeItem(storageKey); } catch { /* the previous key remains safe to verify */ }
  }
  function closeConfirmation(unresolved: boolean) {
    setConfirmationOpen(false);
    if (unresolved) setPendingSubmitted(true); else { clearPending(); setPending(null); }
  }
  function saved(result: ImportResult) {
    restoreRequest.current?.abort(); setResumeId(null); setLoading(false);
    setPreview(result.import); setPage(1); setPending(null); setPendingSubmitted(false); setConfirmationOpen(false); setError("");
    try { store({ previewId: result.import.id }); } catch { /* preserve the server result on this screen */ }
    setNotice(result.replayed ? "Importação conferida: este cadastro já havia sido concluído. Nenhum produto foi duplicado." : `${result.import.createdCount} ${result.import.createdCount === 1 ? "produto cadastrado" : "produtos cadastrados"} com saldo zero.`);
    setFile(null); if (inputRef.current) inputRef.current.value = "";
    window.dispatchEvent(new Event("prevision:stock-changed"));
  }
  const visible = preview?.rows.slice((page - 1) * 20, page * 20) ?? [];
  const totalPages = Math.max(1, Math.ceil((preview?.rows.length ?? 0) / 20));
  const expired = preview?.status === "EXPIRED" || !!preview && new Date(preview.expiresAt).getTime() <= Date.now();
  const canConfirm = preview?.status === "PREVIEW" && preview.canConfirm && !expired && !pending && !busy;

  return <>
    <section className="management-panel transfer-upload-panel" aria-labelledby={`${id}-upload-title`}>
      <div className="transfer-section-heading"><div><p className="eyebrow">CADASTRO EM LOTE</p><h2 id={`${id}-upload-title`}>Comece pelo modelo de produtos</h2><p>Preencha os dados, envie o arquivo e confira a prévia antes de cadastrar.</p></div><div className="transfer-template-actions"><button className="button-secondary" type="button" disabled={!!templateBusy} onClick={() => void template("csv")}>{templateBusy === "csv" ? "Baixando…" : "Modelo CSV"}</button><button className="button-secondary" type="button" disabled={!!templateBusy} onClick={() => void template("xlsx")}>{templateBusy === "xlsx" ? "Baixando…" : "Modelo Excel"}</button></div></div>
      <p className="catalog-confirm-note">A importação cria produtos novos com saldo zero. Categorias e fornecedores devem existir previamente. Para alterar quantidades, utilize uma entrada de estoque; cadastros existentes permanecem preservados.</p>
      <form className="transfer-upload-form" onSubmit={(event) => void upload(event)}><div className="form-field"><label htmlFor={`${id}-file`}>Arquivo de produtos</label><input ref={inputRef} id={`${id}-file`} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy || loading || !!pending || !recoveryReady || !!recoveryError} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(""); setPreview(null); setResumeId(null); try { sessionStorage.removeItem(storageKey); } catch { /* a new confirmation still requires storage */ } }} /><small>CSV em UTF-8 ou Excel .xlsx. Até 2 MB e 200 produtos por arquivo. Use códigos de barras como texto para preservar zeros.</small></div><button className="button-primary" disabled={!file || busy || loading || !!pending || !recoveryReady || !!recoveryError} type="submit">{busy ? "Conferindo arquivo…" : "Conferir arquivo"}<Icon name="arrow-right" /></button></form>
      <div className="transfer-reference-links"><span>Conferir cadastros:</span><Link href="/produtos">Produtos</Link><Link href="/categorias">Categorias</Link><Link href="/fornecedores">Fornecedores</Link></div>
    </section>
    {notice && <p className="form-message form-success catalog-notice" role="status">{notice}</p>}{error && <div className="form-message form-error catalog-notice" role="alert"><p>{error}</p>{resumeId && <button className="text-link" type="button" onClick={() => setRefresh((value) => value + 1)}>Consultar novamente</button>}</div>}
    {recoveryError && <div className="form-message form-error catalog-notice" role="alert"><p>{recoveryError}</p><Link className="text-link" href="/produtos">Conferir produtos cadastrados</Link><button className="text-link" type="button" onClick={() => { try { sessionStorage.removeItem(storageKey); setRecoveryError(""); } catch { setError("O navegador continua bloqueando o armazenamento desta página."); } }}>Já conferi os produtos; liberar esta aba</button></div>}
    {pending && !confirmationOpen && <div className="form-message stock-pending-message transfer-pending" role="status"><div><strong>Há uma importação aguardando conferência</strong><p>Verifique o pedido anterior antes de enviar outro arquivo nesta aba.</p></div><button className="button-secondary" type="button" onClick={() => setConfirmationOpen(true)}>Conferir pedido</button></div>}
    {loading && <section className="management-panel"><div className="table-state" role="status"><span className="catalog-loader" /><p>Recuperando a prévia da importação…</p></div></section>}
    {!loading && preview && <section className="management-panel catalog-panel transfer-preview" aria-labelledby={`${id}-preview-title`}>
      <div className="panel-heading"><div><p className="eyebrow">{preview.status === "COMPLETED" ? "IMPORTAÇÃO CONCLUÍDA" : expired ? "PRÉVIA EXPIRADA" : "PRÉVIA DO ARQUIVO"}</p><h2 id={`${id}-preview-title`}>{preview.fileName}</h2><p>Conferido em {date(preview.createdAt)}{preview.status !== "COMPLETED" && <> · Válido até {date(preview.expiresAt)}</>}</p></div><span className="count-badge">{preview.rowCount} linhas</span></div>
      <div className="transfer-summary"><div><span>Linhas conferidas</span><strong>{preview.rowCount}</strong></div><div><span>Linhas válidas</span><strong>{preview.validCount}</strong></div><div className={preview.errorCount ? "transfer-summary-error" : ""}><span>Linhas com erro</span><strong>{preview.errorCount}</strong></div>{preview.status === "COMPLETED" && <div><span>Produtos cadastrados</span><strong>{preview.createdCount}</strong></div>}</div>
      {preview.status === "COMPLETED" ? <p className="transfer-result-note">O cadastro deste lote está concluído. Os produtos foram criados com saldo zero. <Link href="/produtos" className="text-link">Consultar produtos</Link></p> : expired ? <p className="form-message inventory-warning transfer-inline-message">Esta prévia expirou. Envie o arquivo novamente para conferir os dados atuais antes do cadastro.</p> : preview.errorCount > 0 && <p className="form-message inventory-warning transfer-inline-message">Corrija as linhas com erro no arquivo e envie novamente. O lote só poderá ser confirmado quando todas as linhas estiverem válidas.</p>}
      {preview.rows.length > 0 && <div className="table-scroll"><table className="catalog-table transfer-import-table"><thead><tr><th scope="col">Linha</th>{preview.columns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}<th scope="col">Conferência</th></tr></thead><tbody>{visible.map((row) => <tr key={row.rowNumber} className={row.errors.length ? "transfer-row-error" : undefined}><th scope="row">{row.rowNumber}</th>{preview.columns.map((column) => <td key={column.key}><PreviewValue value={row.data[column.key]} /></td>)}<td>{row.errors.length ? <ul className="transfer-row-errors">{row.errors.map((issue, index) => <li key={index}>{issue.column && <strong>{preview.columns.find((column) => column.key === issue.column)?.label ?? issue.column}: </strong>}{issue.message}</li>)}</ul> : <span className="transfer-valid"><Icon name="check" />Válida</span>}</td></tr>)}</tbody></table></div>}
      <div className="catalog-pagination"><span>{preview.rows.length ? `${(page - 1) * 20 + 1}–${Math.min(page * 20, preview.rows.length)} de ${preview.rows.length} linhas` : "Nenhuma linha para exibir"}</span><div><button type="button" className="button-secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Anterior</button><span>{page} / {totalPages}</span><button type="button" className="button-secondary" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Próxima</button></div></div>
      {preview.status !== "COMPLETED" && <div className="transfer-confirm-footer"><p>{preview.errorCount ? "Nenhum produto foi cadastrado. Corrija o arquivo e gere outra prévia." : "Confira as informações de todas as linhas. Confirmar cria o lote inteiro, com saldo zero."}</p><button className="button-primary" type="button" disabled={!canConfirm} onClick={beginConfirmation}>Confirmar importação<Icon name="arrow-right" /></button></div>}
    </section>}
    {pending && confirmationOpen && <ImportConfirmation key={pending.idempotencyKey} pending={pending} recovered={pendingSubmitted} persist={() => { store({ previewId: pending.importId, pending }); setPendingSubmitted(true); }} clear={clearPending} onClose={closeConfirmation} onSaved={saved} />}
  </>;
}
