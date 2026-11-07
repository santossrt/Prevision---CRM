import type { Metadata } from "next";
import Link from "next/link";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { UsersManager } from "@/components/users/users-manager";
import { requireIdentity } from "@/server/auth/identity";
import { getAuthCapabilities } from "@/server/auth/settings";

export const metadata: Metadata = { title: "Usuários" };

export default async function UsersPage() {
  const identity = await requireIdentity();
  return <WorkspaceShell identity={identity}><div className="management-intro"><p className="eyebrow">EQUIPE E ACESSO</p><h1>As pessoas por trás da operação<span>.</span></h1><p>Gerencie os usuários autorizados e mantenha o acesso da equipe organizado.</p></div>{identity.permissions.includes("users.manage") ? <UsersManager canManageRoles={identity.permissions.includes("roles.manage")} canResetPassword={identity.role === "ADMINISTRATOR"} emailDelivery={getAuthCapabilities().emailDelivery} /> : <section className="management-panel denied-panel"><h2>Esta área exige permissão de gerenciamento</h2><p>Fale com o administrador se precisar de acesso à gestão de usuários.</p><Link href="/" className="button-secondary">Voltar para a visão geral</Link></section>}</WorkspaceShell>;
}
