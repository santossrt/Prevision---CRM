"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { CreateMovementInput, MovementResult, NewMovementType, StockMovementDTO, StockOptions, StockProductDTO } from "@/lib/stock/types";
import { Icon } from "@/components/ui/icon";
import { StockBalancesList, StockHistoryList } from "./stock-lists";
import { StockEditor } from "./stock-editor";
import { StockCompensation, StockMovementDetail } from "./stock-detail";
import { StockSubmission } from "./stock-submission";
import { recoverIntent, type StockIntent } from "./stock-intent";
import { isCancelled, stockError, stockRequest } from "./stock-api";

type Dialog = { mode: "create"; type: NewMovementType; product?: StockProductDTO; initial?: CreateMovementInput }
  | { mode: "detail"; id: string } | { mode: "compensate"; movement: StockMovementDTO; justification?: string };

export function StockManager({ ownerId, canWrite, canAdjust, initialSearch = "", initialStock = "all", initialProduct, initialMovementId }: {
  ownerId: string; canWrite: boolean; canAdjust: boolean; initialSearch?: string; initialStock?: "all" | "normal" | "low" | "empty";
  initialProduct?: { id: string; name: string; sku: string }; initialMovementId?: string;
}) {
  const id = useId();
  const storageKey = `prevision.stock.pending.v1.${ownerId}`;
  const [tab, setTab] = useState<"balances" | "history">("balances");
  const [historyProduct, setHistoryProduct] = useState<{ id: string; name: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [options, setOptions] = useState<StockOptions | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<StockIntent | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const openedMovement = useRef<string | null>(null);

  useEffect(() => { setTab("balances"); }, [initialSearch, initialStock]);

  useEffect(() => {
    if (recoveryReady && !pending && !submissionOpen && initialMovementId && openedMovement.current !== initialMovementId) {
      openedMovement.current = initialMovementId;
      setTab("history"); setDialog({ mode: "detail", id: initialMovementId });
    }
  }, [initialMovementId, recoveryReady, pending, submissionOpen]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) { setPending(recoverIntent(raw)); setSubmitted(true); setSubmissionOpen(true); }
    } catch { setRecoveryError("Não foi possível recuperar o registro local de um possível lançamento pendente. Confira o histórico antes de registrar novas operações nesta aba."); }
    setRecoveryReady(true);
  }, [storageKey]);

  useEffect(() => {
    const controller = new AbortController();
    setOptionsError("");
    void stockRequest<StockOptions>("/api/stock/options", { signal: controller.signal }).then(setOptions)
      .catch((failure) => { if (!isCancelled(failure)) setOptionsError(stockError(failure)); });
    return () => controller.abort();
  }, [revision]);

  function removePersisted() { try { sessionStorage.removeItem(storageKey); } catch { /* replaying the stored key remains safe */ } setSubmitted(false); }
  function beginReview(intent: StockIntent) { setDialog(null); setPending(intent); setSubmitted(false); setSubmissionOpen(true); }
  function closeSubmission(unresolved: boolean) {
    setSubmissionOpen(false);
    if (unresolved) setSubmitted(true);
    else { removePersisted(); setPending(null); }
  }
  function saved(result: MovementResult) {
    removePersisted(); setPending(null); setSubmissionOpen(false); setDialog(null); setError("");
    setNotice(result.replayed ? "Lançamento conferido: esta operação já estava registrada. O estoque não foi alterado novamente." : "Movimentação registrada. O saldo e o histórico foram atualizados.");
    setRevision((value) => value + 1);
    window.dispatchEvent(new Event("prevision:stock-changed"));
  }
  async function editIntent() {
    if (!pending) return;
    const intent = pending;
    removePersisted(); setSubmissionOpen(false); setPending(null);
    if (intent.kind === "movement") setDialog({ mode: "create", type: intent.body.type, initial: intent.body });
    else {
      try {
        const movement = await stockRequest<StockMovementDTO>(`/api/stock/movements/${encodeURIComponent(intent.movementId)}`);
        setDialog({ mode: "compensate", movement, justification: intent.body.justification });
      } catch (failure) { setError(stockError(failure)); }
    }
  }
  function create(type: NewMovementType, product?: StockProductDTO) { setNotice(""); setError(""); setDialog({ mode: "create", type, product }); }
  const canStart = recoveryReady && !recoveryError && !pending && !!options;
  const preferredType: NewMovementType = canWrite ? "ENTRY" : "POSITIVE_ADJUSTMENT";

  return <>
    {initialProduct && <div className="form-message stock-pending-message catalog-notice"><div><strong>Produto da notificação: {initialProduct.name}</strong><p>SKU {initialProduct.sku}. O saldo consultado é o atual; a notificação preserva a condição registrada na data do aviso.</p></div><button className="text-link" type="button" onClick={() => { setHistoryProduct(initialProduct); setTab("history"); }}>Consultar histórico deste produto</button></div>}
    <div className="stock-actions" aria-label="Registrar movimentação">{canWrite && <><button className="button-primary" type="button" disabled={!canStart} onClick={() => create("ENTRY")}>Registrar entrada<Icon name="arrow-right" /></button><button className="button-secondary" type="button" disabled={!canStart} onClick={() => create("EXIT")}>Registrar saída</button></>}{canAdjust && <button className={canWrite ? "button-secondary" : "button-primary"} type="button" disabled={!canStart} onClick={() => create("POSITIVE_ADJUSTMENT")}>Ajustar estoque</button>}<button type="button" className="text-link stock-refresh" onClick={() => setRevision((value) => value + 1)}>Atualizar consulta</button></div>
    {notice && <p className="form-message form-success catalog-notice" role="status">{notice}</p>}{error && <p className="form-message form-error catalog-notice" role="alert">{error}</p>}
    {optionsError && <div className="form-message form-error catalog-notice" role="alert"><p>Não foi possível carregar as opções para novos lançamentos. {optionsError}</p><button type="button" className="text-link" onClick={() => setRevision((value) => value + 1)}>Tentar novamente</button></div>}
    {pending && !submissionOpen && <div className="form-message stock-pending-message stock-pending-banner" role="status"><div><strong>Há um lançamento aguardando conferência</strong><p>Conclua a verificação do pedido anterior antes de registrar outra movimentação nesta aba.</p></div><button type="button" className="button-secondary" onClick={() => setSubmissionOpen(true)}>Conferir lançamento</button></div>}
    {recoveryError && <div className="form-message form-error catalog-notice" role="alert"><p>{recoveryError}</p><button type="button" className="text-link" onClick={() => { setTab("history"); setHistoryProduct(null); }}>Consultar o histórico</button><button type="button" className="text-link" onClick={() => { removePersisted(); setRecoveryError(""); }}>Já conferi o histórico; liberar esta aba</button></div>}
    <div className="catalog-tabs stock-tabs" role="tablist" aria-label="Consultas de estoque"><button id={`${id}-balances-tab`} type="button" role="tab" aria-selected={tab === "balances"} aria-controls={`${id}-balances`} tabIndex={tab === "balances" ? 0 : -1} onClick={() => setTab("balances")} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); setTab("history"); document.getElementById(`${id}-history-tab`)?.focus(); } }}><Icon name="package" />Saldo atual</button><button id={`${id}-history-tab`} type="button" role="tab" aria-selected={tab === "history"} aria-controls={`${id}-history`} tabIndex={tab === "history" ? 0 : -1} onClick={() => setTab("history")} onKeyDown={(event) => { if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); setTab("balances"); document.getElementById(`${id}-balances-tab`)?.focus(); } }}><Icon name="movement" />Histórico</button></div>
    <div id={`${id}-balances`} role="tabpanel" aria-labelledby={`${id}-balances-tab`} hidden={tab !== "balances"}><StockBalancesList key={`${initialStock}:${initialSearch}`} initialSearch={initialSearch} initialStock={initialStock} options={options} revision={revision} canMove={canStart && (canWrite || canAdjust)} onCreate={(product) => create(preferredType, product)} onHistory={(product) => { setHistoryProduct({ id: product.id, name: product.name }); setTab("history"); document.getElementById(`${id}-history-tab`)?.focus(); }} /></div>
    <div id={`${id}-history`} role="tabpanel" aria-labelledby={`${id}-history-tab`} hidden={tab !== "history"}><StockHistoryList key={historyProduct?.id ?? "all"} product={historyProduct} onClearProduct={() => setHistoryProduct(null)} revision={revision} onOpen={(movementId) => setDialog({ mode: "detail", id: movementId })} /></div>
    <p className="management-footnote"><Icon name="shield" />{canAdjust ? "Entradas, saídas, ajustes e compensações são validados no servidor e registrados com o responsável." : canWrite ? "Você pode registrar entradas e saídas. Ajustes e compensações exigem permissão adicional." : "Seu acesso permite consultar o saldo e o histórico do estoque."}</p>
    {dialog?.mode === "create" && options && <StockEditor initialType={dialog.type} initialProduct={dialog.product} initial={dialog.initial} options={options} canWrite={canWrite} canAdjust={canAdjust} onClose={() => setDialog(null)} onReview={beginReview} />}
    {dialog?.mode === "detail" && <StockMovementDetail key={dialog.id} movementId={dialog.id} canAdjust={canAdjust && canStart} onClose={() => setDialog(null)} onOpen={(movementId) => setDialog({ mode: "detail", id: movementId })} onCompensate={(movement) => setDialog({ mode: "compensate", movement })} />}
    {dialog?.mode === "compensate" && <StockCompensation movement={dialog.movement} initialJustification={dialog.justification} onClose={() => setDialog(null)} onReview={beginReview} />}
    {pending && submissionOpen && <StockSubmission key={pending.body.idempotencyKey} intent={pending} recovered={submitted} persist={() => { sessionStorage.setItem(storageKey, JSON.stringify({ intent: pending })); setSubmitted(true); }} removePersisted={removePersisted} onClose={closeSubmission} onEdit={() => void editIntent()} onSaved={saved} />}
  </>;
}
