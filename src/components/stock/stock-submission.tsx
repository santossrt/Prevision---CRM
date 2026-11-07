"use client";
import { useRef, useState } from "react";
import type { MovementResult } from "@/lib/stock/types";
import { CatalogModal } from "@/components/catalog/catalog-modal";
import type { MovementReview, StockIntent } from "./stock-intent";
import { StockSubmissionError, submitStockIntent } from "./stock-api";
import { date, decimal, estimatedBalance, estimatedTotal, money, movementLabels } from "./stock-format";

export function StockReview({ review }: { review: MovementReview }) {
  return <><div className="stock-review-product"><strong>{review.productName}</strong><span>{review.sku} · {movementLabels[review.type]}</span></div><dl className="stock-detail-grid">
    <div><dt>Quantidade movimentada</dt><dd className={review.quantityDelta.startsWith("-") ? "stock-decrease" : "stock-increase"}>{review.quantityDelta.startsWith("-") ? "" : "+"}{decimal(review.quantityDelta)} {review.unit}</dd></div>
    <div><dt>Saldo consultado</dt><dd>{decimal(review.quantityBefore)} {review.unit}</dd></div>
    <div><dt>Saldo previsto</dt><dd>{decimal(estimatedBalance(review.quantityBefore, review.quantityDelta))} {review.unit}</dd></div>
    <div><dt>Data da operação</dt><dd>{date(review.occurredAt)}</dd></div>
    <div><dt>Custo unitário</dt><dd>{money(review.unitCost)}</dd></div><div><dt>Custo total</dt><dd>{money(estimatedTotal(review.quantityDelta, review.unitCost))}</dd></div>
    {review.unitPrice !== null && <><div><dt>Preço unitário</dt><dd>{money(review.unitPrice)}</dd></div><div><dt>Valor total de venda</dt><dd>{money(estimatedTotal(review.quantityDelta, review.unitPrice))}</dd></div></>}
    {review.supplier && <div><dt>Fornecedor</dt><dd>{review.supplier}</dd></div>}{review.customer && <div><dt>Cliente</dt><dd>{review.customer}</dd></div>}
    {review.justification && <div className="stock-detail-full"><dt>Justificativa</dt><dd>{review.justification}</dd></div>}{review.notes && <div className="stock-detail-full"><dt>Observações</dt><dd>{review.notes}</dd></div>}
  </dl></>;
}

export function StockSubmission({ intent, recovered, persist, removePersisted, onClose, onEdit, onSaved }: {
  intent: StockIntent; recovered: boolean; persist: () => void; removePersisted: () => void;
  onClose: (unresolved: boolean) => void; onEdit: () => void; onSaved: (result: MovementResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(recovered);
  const [error, setError] = useState("");
  const [rejected, setRejected] = useState(false);
  const inFlight = useRef(false);
  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setRejected(false);
    try {
      try { persist(); }
      catch { setError("O navegador não conseguiu guardar este pedido para uma eventual recuperação. Libere o armazenamento desta página e tente novamente; nada foi enviado."); return; }
      const result = await submitStockIntent(intent);
      removePersisted();
      onSaved(result);
    } catch (failure) {
      const unknown = uncertain || !(failure instanceof StockSubmissionError) || failure.uncertain;
      setUncertain(unknown); setRejected(!unknown);
      if (!unknown) removePersisted();
      setError(failure instanceof Error ? failure.message : "Não foi possível confirmar o lançamento.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <CatalogModal title={uncertain ? "Conferir lançamento pendente" : "Confirmar movimentação"} caption="CONTROLE DE ESTOQUE" onClose={() => onClose(uncertain)} busy={busy}>
    <StockReview review={intent.review} />
    <p className="catalog-confirm-note">{intent.kind === "compensation" ? "Será criada uma movimentação inversa, preservando o registro original e seus valores. A correção será registrada com seu usuário." : "Esta confirmação altera o estoque compartilhado e registra os valores e o responsável no histórico."} O saldo definitivo é conferido pelo servidor no momento da confirmação.</p>
    {uncertain && <div className="form-message stock-pending-message" role="status"><p>A confirmação anterior ficou pendente. Use o botão abaixo para verificar e repetir o mesmo pedido com segurança. Ele não gera uma segunda movimentação.</p><p>Você pode fechar esta janela e retomar a conferência nesta mesma aba.</p></div>}
    {error && <p className="form-message form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="button-secondary" disabled={busy} onClick={() => onClose(uncertain)}>{uncertain ? "Verificar depois" : "Cancelar"}</button>{!uncertain && <button type="button" className="text-link" disabled={busy} onClick={onEdit}>{rejected ? "Corrigir dados" : "Voltar e editar"}</button>}<button type="button" className="button-primary" disabled={busy} onClick={() => void submit()}>{busy ? "Confirmando…" : uncertain ? "Verificar o mesmo pedido" : "Confirmar lançamento"}</button></div>
  </CatalogModal>;
}
