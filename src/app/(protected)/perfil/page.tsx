import type { Metadata } from "next";
import { GoogleConnection } from "@/components/auth/access-forms";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { roleLabels } from "@/components/auth/access-types";
import { Icon } from "@/components/ui/icon";
import { requireIdentity } from "@/server/auth/identity";
import { getAuthCapabilities } from "@/server/auth/settings";

export const metadata: Metadata = { title: "Meu perfil" };

export default async function ProfilePage() {
  const [identity, capabilities] = await Promise.all([requireIdentity(), getAuthCapabilities()]);
  return <WorkspaceShell identity={identity}><div className="management-intro"><p className="eyebrow">SEU ACESSO INDIVIDUAL</p><h1>Seu perfil no Prevision<span>.</span></h1><p>Confira seus dados e as formas de acessar o seu ambiente.</p></div><div className="profile-grid"><section className="management-panel profile-panel" aria-labelledby="profile-data-title"><div className="profile-panel-heading"><span className="module-icon"><Icon name="partners" /></span><div><h2 id="profile-data-title">Seus dados</h2><p>Informações do seu cadastro autorizado.</p></div></div><dl className="profile-data"><div><dt>Nome</dt><dd>{identity.name || "Nome não informado"}</dd></div><div><dt>E-mail</dt><dd>{identity.email}</dd></div><div><dt>Perfil de acesso</dt><dd><span className="role-badge">{roleLabels[identity.role]}</span></dd></div><div><dt>Acesso com senha</dt><dd>{identity.hasPassword ? "Senha definida" : "Sem senha definida"}</dd></div></dl><p className="profile-note">Para alterar seus dados ou permissões, fale com o administrador do ambiente.</p></section><section className="management-panel profile-panel" aria-labelledby="google-profile-title"><div className="profile-panel-heading"><span className="google-profile-icon" aria-hidden="true">G</span><div><h2 id="google-profile-title">Sua conta Google</h2><p>Mais uma forma de entrar no seu espaço.</p></div></div><GoogleConnection hasPassword={identity.hasPassword} googleLinked={identity.googleLinked} googleAccessAllowed={identity.googleAccessAllowed} googleAvailable={capabilities.google} /></section></div><div className="profile-privacy-note"><Icon name="shield" /><p>Seu perfil determina quais áreas você pode acessar. Ter uma conta Google vinculada mantém as permissões já definidas para seu usuário.</p></div></WorkspaceShell>;
}
