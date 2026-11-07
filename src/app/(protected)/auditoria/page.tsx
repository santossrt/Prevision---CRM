import Link from "next/link";
import type { Metadata } from "next";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { AuditManager } from "@/components/audit/audit-manager";
import { requireIdentity } from "@/server/auth/identity";

export const metadata: Metadata = { title: "Auditoria de atividades" };
export default async function AuditPage() {
  const identity = await requireIdentity();
  return <WorkspaceShell identity={identity}><div className="management-intro"><p className="eyebrow">AUDITORIA DE ATIVIDADES</p><h1>O histórico da sua operação<span>.</span></h1><p>Consulte ações, responsáveis e alterações registradas no Prevision.</p></div>{identity.permissions.includes("audit.read") ? <AuditManager /> : <section className="management-panel denied-panel"><h2>Esta área exige permissão de auditoria</h2><p>Fale com o administrador se precisar consultar o histórico de atividades.</p><Link className="button-secondary" href="/">Voltar para a visão geral</Link></section>}</WorkspaceShell>;
}
