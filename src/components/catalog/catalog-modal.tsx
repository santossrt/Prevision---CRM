"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";

export function CatalogModal({ title, caption, children, busy = false, wide = false, onClose }: { title: string; caption: string; children: ReactNode; busy?: boolean; wide?: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, []);

  return <dialog className={`user-dialog catalog-dialog${wide ? " catalog-dialog-wide" : ""}`} ref={dialogRef} aria-labelledby={titleId} aria-busy={busy} onClose={onClose} onCancel={(event) => { if (busy) event.preventDefault(); }} onClick={(event) => { if (event.target === event.currentTarget && !busy) dialogRef.current?.close(); }}><div className="user-dialog-content"><div className="dialog-heading"><div><p className="eyebrow">{caption}</p><h2 id={titleId}>{title}</h2></div><button type="button" className="icon-button" aria-label="Fechar janela" disabled={busy} onClick={() => dialogRef.current?.close()}><Icon name="close" /></button></div>{children}</div></dialog>;
}
