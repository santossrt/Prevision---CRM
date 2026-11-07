import Link from "next/link";
import type { Metadata } from "next";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { TransfersManager } from "@/components/transfers/transfers-manager";
import { canUseTransfers } from "@/lib/transfers/access";
import { requireIdentity } from "@/server/auth/identity";

export const metadata: Metadata = { title: "Importação e exportação" };

export default async function TransfersPage() {
  const identity = await requireIdentity();
  return <WorkspaceShell identity={identity}><div className="management-intro transfer-intro"><p className="eyebrow">IMPORTAÇÃO E EXPORTAÇÃO</p><h1>Arquivos, com conferência<span>.</span></h1><p>Cadastre produtos por planilha e gere arquivos de consulta com os dados do seu ambiente.</p></div>{canUseTransfers(identity.permissions) ? <TransfersManager ownerId={identity.id} permissions={identity.permissions} /> : <section className="management-panel denied-panel"><h2>Esta área exige permissão de importação ou relatório</h2><p>Fale com o administrador se precisar importar produtos ou gerar arquivos dos módulos.</p><Link className="button-secondary" href="/">Voltar para a visão geral</Link></section>}</WorkspaceShell>;
}
