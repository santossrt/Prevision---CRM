import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { StockManager } from "@/components/stock/stock-manager";
import { getRequestPrincipal, publicIdentity } from "@/server/auth/identity";
import { getStockProduct } from "@/server/stock/service";
import { ApplicationError } from "@/server/errors/application-error";

export const metadata: Metadata = { title: "Controle de estoque" };

export default async function StockPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await getRequestPrincipal();
  if (!actor) redirect("/login");
  const identity = publicIdentity(actor);
  const query = await searchParams;
  let initialSearch = typeof query.search === "string" && !query.search.includes("\0") ? query.search.trim().slice(0, 100) : "";
  const initialStock = query.stock === "low" || query.stock === "empty" || query.stock === "normal" ? query.stock : "all";
  const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
  const initialMovementId = uuid(query.movementId) ? query.movementId : undefined;
  let initialProduct: { id: string; name: string; sku: string } | undefined;
  let targetError = "";
  if (uuid(query.productId) && identity.permissions.includes("stock.read")) {
    try {
      const product = await getStockProduct(actor, query.productId);
      initialProduct = { id: product.id, name: product.name, sku: product.sku };
      initialSearch = product.sku;
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      targetError = "Não foi possível consultar o produto desta notificação. Confira seu acesso ou consulte o histórico do estoque.";
    }
  }
  return <WorkspaceShell identity={identity}><div className="management-intro stock-intro"><p className="eyebrow">CONTROLE DE ESTOQUE</p><h1>Cada movimento, registrado<span>.</span></h1><p>Acompanhe o que entra, o que sai e o saldo compartilhado da sua operação.</p></div>{targetError && <p className="form-message form-error catalog-notice" role="alert">{targetError}</p>}{identity.permissions.includes("stock.read") ? <StockManager ownerId={identity.id} canWrite={identity.permissions.includes("stock.write")} canAdjust={identity.permissions.includes("stock.adjust")} initialSearch={initialSearch} initialStock={initialStock} initialProduct={initialProduct} initialMovementId={initialMovementId} /> : <section className="management-panel denied-panel"><h2>Esta área exige permissão de consulta</h2><p>Fale com o administrador se precisar de acesso ao estoque.</p><Link className="button-secondary" href="/">Voltar para a visão geral</Link></section>}</WorkspaceShell>;
}
