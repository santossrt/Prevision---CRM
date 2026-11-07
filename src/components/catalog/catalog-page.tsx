import Link from "next/link";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { requireIdentity } from "@/server/auth/identity";
import { Icon } from "@/components/ui/icon";
import type { CatalogKind } from "@/lib/catalog/types";
import { catalogMeta } from "./catalog-meta";
import { CatalogManager } from "./catalog-manager";

export async function CatalogPage({ kind, initialBarcode }: { kind: CatalogKind; initialBarcode?: string }) {
  const identity = await requireIdentity();
  const meta = catalogMeta[kind];
  const canRead = identity.permissions.includes("catalog.read");
  return <WorkspaceShell identity={identity}><div className="management-intro catalog-intro"><p className="eyebrow">CADASTROS / {meta.title.toLocaleUpperCase("pt-BR")}</p><h1>{meta.headline}<span>.</span></h1><p>{meta.description}</p></div>{canRead ? <><nav className="catalog-tabs" aria-label="Cadastros">{(Object.entries(catalogMeta) as [CatalogKind, typeof meta][]).map(([key, item]) => <Link key={key} href={item.path} aria-current={key === kind ? "page" : undefined}><Icon name={item.icon} />{item.title}</Link>)}</nav><CatalogManager key={`${kind}:${initialBarcode ?? ""}`} kind={kind} initialBarcode={initialBarcode} canWrite={identity.permissions.includes("catalog.write")} /></> : <section className="management-panel denied-panel"><h2>Esta área exige permissão de consulta</h2><p>Fale com o administrador se precisar de acesso aos cadastros.</p><Link href="/" className="button-secondary">Voltar para a visão geral</Link></section>}</WorkspaceShell>;
}
