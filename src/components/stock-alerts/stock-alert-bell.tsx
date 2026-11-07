"use client";

import Link from "next/link";
import { useState } from "react";
import { CatalogModal } from "@/components/catalog/catalog-modal";
import type { StockAlertSummary } from "@/lib/stock/alerts-types";
import { StockAlertFeed } from "./stock-alert-feed";
import { useStockAlerts } from "./use-stock-alerts";

export function StockAlertBell() {
  const [open, setOpen] = useState(false);
  const { data, error } = useStockAlerts<StockAlertSummary>("/api/stock/alerts/summary");
  const label = data ? `${data.total} ${data.total === 1 ? "alerta ativo" : "alertas ativos"} de estoque. Consultar alertas.` : "Consultar alertas de estoque";
  return <><button type="button" className="stock-alert-bell icon-button" aria-label={label} aria-haspopup="dialog" aria-expanded={open} title={error ? "Não foi possível atualizar os alertas. Abra para tentar novamente." : "Alertas de estoque"} onClick={() => setOpen(true)}>
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
    {data && data.total > 0 && <span className="stock-alert-bell-count" aria-hidden="true">{data.total > 99 ? "99+" : data.total}</span>}{error && <span className="stock-alert-bell-error" aria-hidden="true">!</span>}
  </button>{open && <CatalogModal title="Alertas de estoque" caption="ATENÇÃO À REPOSIÇÃO" wide onClose={() => setOpen(false)}><StockAlertFeed compact onNavigate={() => setOpen(false)} /><div className="dialog-actions"><button type="button" className="button-secondary" onClick={() => setOpen(false)}>Fechar</button><Link href="/#alertas" className="button-primary" onClick={() => setOpen(false)}>Ver no painel inicial</Link></div></CatalogModal>}</>;
}
