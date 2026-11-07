import Link from "next/link";
import type { Metadata } from "next";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { AnalysesManager } from "@/components/analyses/analyses-manager";
import { canViewAnalyses } from "@/lib/analyses/access";
import { requireIdentity } from "@/server/auth/identity";

export const metadata: Metadata = { title: "Curva ABC e reposição" };
export default async function AnalysesPage() {
  const identity = await requireIdentity();
  return <WorkspaceShell identity={identity}><div className="management-intro analysis-intro"><p className="eyebrow">ANÁLISES DO ESTOQUE</p><h1>Relevância para decidir, histórico para planejar<span>.</span></h1><p>Classifique o consumo financeiro e consulte estimativas de reposição com critérios explicados.</p></div>{canViewAnalyses(identity.permissions) ? <AnalysesManager ownerId={identity.id} /> : <section className="management-panel denied-panel"><h2>Esta área exige consulta de estoque e relatórios</h2><p>Fale com o administrador se precisar acessar as análises do seu ambiente.</p><Link href="/" className="button-secondary">Voltar para a visão geral</Link></section>}</WorkspaceShell>;
}
