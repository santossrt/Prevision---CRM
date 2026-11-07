import Link from "next/link";
import { StockAlertFeed } from "./stock-alert-feed";

export function StockAlertDashboard({ canConfigure }: { canConfigure: boolean }) {
  return <section id="alertas" className="stock-alert-dashboard" aria-labelledby="stock-alert-title"><div className="stock-alert-heading"><div><p className="eyebrow">ATENÇÃO AO ESTOQUE</p><h2 id="stock-alert-title">O que precisa de reposição<span>.</span></h2><p>Veja produtos sem saldo ou com quantidade até o mínimo definido.</p></div>{canConfigure && <Link href="/produtos" className="button-secondary">Configurar mínimos nos produtos</Link>}</div><StockAlertFeed /></section>;
}
