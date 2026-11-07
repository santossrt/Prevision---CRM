"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { NoticeInput, NoticeResult } from "@/lib/notifications/types";
import { CatalogModal } from "@/components/catalog/catalog-modal";
import { NotificationRequestError, noticeBody, noticeStorageKey, notificationError, publishNotice, recoverStoredNotice } from "./notifications-api.ts";

export function NoticeComposer({ ownerId, onClose, onPublished }: { ownerId: string; onClose: () => void; onPublished: (result: NoticeResult) => void }) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [intent, setIntent] = useState<NoticeInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const pending = useRef(false);
  const storageKey = noticeStorageKey(ownerId);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const restored = recoverStoredNotice(raw);
        setIntent(restored.input); setTitle(restored.input.title); setMessage(restored.input.message); setUncertain(restored.uncertain);
      }
    } catch { setStorageError("Não foi possível recuperar um possível aviso pendente nesta aba. Confira a central antes de iniciar outra publicação."); }
    setReady(true);
  }, [storageKey]);
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    try { setIntent(noticeBody({ title, message, idempotencyKey: crypto.randomUUID() })); }
    catch (failure) { setError(notificationError(failure)); }
  }
  async function publish() {
    if (!intent || pending.current) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ input: intent, uncertain: true })); }
    catch { setError("O navegador precisa permitir o armazenamento desta aba antes de publicar. Isso permite verificar o mesmo pedido se a conexão cair."); return; }
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await publishNotice(intent);
      try { sessionStorage.removeItem(storageKey); } catch { /* A retained key only replays this publication. */ }
      setUncertain(false); onPublished(result);
    }
    catch (failure) {
      const unresolved = uncertain || failure instanceof NotificationRequestError && failure.uncertain;
      setUncertain(unresolved);
      if (!unresolved) {
        try { sessionStorage.removeItem(storageKey); } catch { /* Retaining the same key cannot create a duplicate. */ }
      }
      setError(notificationError(failure));
    } finally { pending.current = false; setBusy(false); }
  }
  return <CatalogModal title={intent ? "Conferir aviso" : "Novo aviso administrativo"} caption="COMUNICAÇÃO DO ADMINISTRADOR" busy={busy} onClose={onClose}>
    {!ready ? <p className="notification-dialog-note" role="status">Conferindo pedidos anteriores nesta aba…</p> : storageError ? <><p className="form-message form-error" role="alert">{storageError}</p><div className="dialog-actions"><button className="button-secondary" type="button" onClick={onClose}>Fechar</button></div></> : intent ? <>
      <p className="notification-dialog-note">Este aviso ficará disponível para todos os usuários autorizados do ambiente. Confira a mensagem antes de publicar.</p>
      <section className="notification-notice-preview" aria-label="Prévia do aviso"><h3>{intent.title}</h3><p>{intent.message}</p></section>
      {uncertain && <p className="form-message stock-pending-message" role="status">O resultado da publicação ficou incerto. Use <strong>Verificar publicação</strong> para reenviar o mesmo pedido com a mesma chave. Se fechar esta janela, abra <strong>Novo aviso</strong> para retomar o pedido nesta aba.</p>}
      {error && <p className="form-message form-error" role="alert">{error}</p>}
      <div className="dialog-actions">{!uncertain && <button type="button" className="button-secondary" disabled={busy} onClick={() => { setIntent(null); setError(""); }}>Editar mensagem</button>}<button type="button" className="button-primary" disabled={busy} onClick={() => void publish()}>{busy ? "Conferindo…" : uncertain ? "Verificar publicação" : "Publicar aviso"}</button></div>
    </> : <form className="notification-notice-form" onSubmit={review}>
      <p className="notification-dialog-note">Publique uma orientação para a equipe. A mensagem será exibida dentro do Prevision.</p>
      <div className="field-group"><label htmlFor={`${id}-title`}>Título</label><input id={`${id}-title`} required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /><span className="notification-field-hint">Até 120 caracteres.</span></div>
      <div className="field-group"><label htmlFor={`${id}-message`}>Mensagem</label><textarea id={`${id}-message`} required rows={6} maxLength={2000} value={message} onChange={(event) => setMessage(event.target.value)} /><span className="notification-field-hint">{message.length}/2.000 caracteres.</span></div>
      {error && <p className="form-message form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button-secondary" onClick={onClose}>Cancelar</button><button type="submit" className="button-primary">Conferir aviso</button></div>
    </form>}
  </CatalogModal>;
}
