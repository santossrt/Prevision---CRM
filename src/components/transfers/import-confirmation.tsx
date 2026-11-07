"use client";

import { useRef, useState } from "react";
import type { ImportResult } from "@/lib/transfers/types";
import { CatalogModal } from "@/components/catalog/catalog-modal";
import { confirmImport, TransferRequestError, type ImportPending } from "./transfers-api";

export function ImportConfirmation({ pending, recovered, persist, clear, onClose, onSaved }: {
  pending: ImportPending; recovered: boolean; persist: () => void; clear: () => void;
  onClose: (unresolved: boolean) => void; onSaved: (result: ImportResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(recovered);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(false);
  const inFlight = useRef(false);
  async function submit() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      try { persist(); }
      catch { setError("Não foi possível guardar o pedido para recuperação. Libere o armazenamento desta página e tente novamente; nada foi enviado."); return; }
      const result = await confirmImport(pending);
      clear(); onSaved(result);
    } catch (failure) {
      const confirmedExpired = failure instanceof TransferRequestError && failure.code === "IMPORT_PREVIEW_EXPIRED";
      const unknown = !confirmedExpired && (uncertain || !(failure instanceof TransferRequestError) || failure.uncertain);
      setUncertain(unknown); setExpired(confirmedExpired);
      if (!unknown) clear();
      setError(failure instanceof Error ? failure.message : "Não foi possível confirmar a importação.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <CatalogModal title={uncertain ? "Conferir importação pendente" : "Confirmar importação"} caption="CADASTRO POR PLANILHA" busy={busy} onClose={() => onClose(uncertain)}>
    <p className="dialog-description">Cadastrar <strong>{pending.rowCount} {pending.rowCount === 1 ? "produto" : "produtos"}</strong> do arquivo <strong>{pending.fileName}</strong>?</p>
    <p className="catalog-confirm-note">Todos os produtos serão cadastrados com saldo zero. A importação preserva cadastros existentes e não cria entradas de estoque. Se alguma informação deixar de ser válida, o lote inteiro será recusado.</p>
    {uncertain && <div className="form-message stock-pending-message" role="status"><p>O resultado anterior ficou incerto. Verifique o mesmo pedido para conferir sua conclusão, sem repetir o cadastro dos produtos.</p><p>Você pode fechar esta janela e retomar nesta aba. Fechar a aba ou apagar o armazenamento não cancela um pedido recebido pelo servidor.</p></div>}
    {error && <p className="form-message form-error" role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="button-secondary" disabled={busy} onClick={() => onClose(uncertain)}>{uncertain ? "Verificar depois" : "Voltar"}</button>{!expired && <button type="button" className="button-primary" disabled={busy} onClick={() => void submit()}>{busy ? "Confirmando…" : uncertain ? "Verificar o mesmo pedido" : "Confirmar cadastro"}</button>}</div>
  </CatalogModal>;
}
