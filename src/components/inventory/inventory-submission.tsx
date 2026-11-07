"use client";

import { useRef, useState } from "react";
import type { InventoryMutationResult } from "@/lib/inventory/types";
import { CatalogModal } from "@/components/catalog/catalog-modal";
import { InventorySubmissionError, submitInventoryIntent, type InventoryIntent } from "./inventory-api";

export function InventorySubmission({ intent, recovered, persist, clear, onClose, onSaved }: {
  intent: InventoryIntent; recovered: boolean; persist: () => void; clear: () => void;
  onClose: (unresolved: boolean) => void; onSaved: (result: InventoryMutationResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(recovered);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      try { persist(); }
      catch { setError("Não foi possível guardar o pedido para uma eventual recuperação. Libere o armazenamento desta página e tente novamente; nada foi enviado."); return; }
      const result = await submitInventoryIntent(intent);
      clear(); onSaved(result);
    } catch (failure) {
      const unknown = uncertain || !(failure instanceof InventorySubmissionError) || failure.uncertain;
      setUncertain(unknown);
      if (!unknown) clear();
      setError(failure instanceof Error ? failure.message : "Não foi possível confirmar o pedido.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <CatalogModal title={uncertain ? "Conferir pedido pendente" : intent.review.title} caption="INVENTÁRIO FÍSICO" busy={busy} onClose={() => onClose(uncertain)}>
    <p className="dialog-description">{intent.review.description}</p>
    {!!intent.review.lines.length && <ul className="inventory-review-lines">{intent.review.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>}
    {intent.kind === "COMPLETE" && <p className="catalog-confirm-note">A confirmação registra os ajustes, os saldos finais e a auditoria na mesma operação. O inventário concluído ficará disponível apenas para consulta.</p>}
    {intent.kind === "REBASE" && <p className="catalog-confirm-note">As quantidades físicas, justificativas e responsáveis dos itens indicados serão limpos. Será necessário conferir esses produtos novamente.</p>}
    {uncertain && <div className="form-message stock-pending-message" role="status"><p>O resultado anterior ficou incerto. Repita este mesmo pedido para conferir sua conclusão, sem duplicar seus efeitos.</p><p>Você pode fechar esta janela e retomar nesta mesma aba. Fechar a aba ou apagar o armazenamento não cancela um pedido que o servidor recebeu.</p></div>}
    {error && <p className="form-message form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="button-secondary" disabled={busy} onClick={() => onClose(uncertain)}>{uncertain ? "Verificar depois" : "Voltar"}</button><button type="button" className="button-primary" disabled={busy} onClick={() => void submit()}>{busy ? "Confirmando…" : uncertain ? "Verificar o mesmo pedido" : "Confirmar"}</button></div>
  </CatalogModal>;
}
