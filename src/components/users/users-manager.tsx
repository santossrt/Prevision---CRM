"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { errorMessage, sendJson } from "@/components/auth/client-api";
import { roleLabels, type WorkspaceIdentity } from "@/components/auth/access-types";

type ManagedUser = Pick<WorkspaceIdentity, "id" | "name" | "email" | "role" | "googleLinked" | "googleAccessAllowed"> & { isActive: boolean };
type UsersResponse = { users: ManagedUser[]; roles: { code: WorkspaceIdentity["role"]; name: string }[]; permissions: unknown[] };
type UserDialogState = { mode: "create" } | { mode: "edit"; user: ManagedUser };

function UserDialog({ state, roles, canManageRoles, onClose, onSaved }: { state: UserDialogState; roles: UsersResponse["roles"]; canManageRoles: boolean; onClose: () => void; onSaved: (message: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const existing = state.mode === "edit" ? state.user : null;
  const [name, setName] = useState(existing?.name || "");
  const [email, setEmail] = useState(existing?.email || "");
  const [role, setRole] = useState<WorkspaceIdentity["role"]>(existing?.role || "OPERATOR");
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);
  const [googleAccessAllowed, setGoogleAccessAllowed] = useState(existing?.googleAccessAllowed ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (existing) await sendJson(`/api/users/${encodeURIComponent(existing.id)}`, { name: name.trim(), isActive, googleAccessAllowed, ...(canManageRoles ? { role } : {}) }, "PATCH");
      else await sendJson("/api/users", { name: name.trim(), email: email.trim(), role: canManageRoles ? role : "OPERATOR", googleAccessAllowed });
      dialogRef.current?.close();
      onSaved(existing ? "As informações do usuário foram atualizadas." : "Usuário cadastrado. Oriente a pessoa a conferir as instruções de ativação ou falar com o administrador.");
    } catch (failure) { setError(errorMessage(failure)); setBusy(false); }
  }

  return <dialog className="user-dialog" ref={dialogRef} aria-labelledby="user-dialog-title" onClose={onClose} onCancel={(event) => { if (busy) event.preventDefault(); }} onClick={(event) => { if (event.target === event.currentTarget && !busy) dialogRef.current?.close(); }}><div className="user-dialog-content"><div className="dialog-heading"><div><p className="eyebrow">EQUIPE E ACESSO</p><h2 id="user-dialog-title">{existing ? "Editar usuário" : "Adicionar usuário"}</h2></div><button className="icon-button" type="button" onClick={() => dialogRef.current?.close()} disabled={busy} aria-label="Fechar formulário"><Icon name="close" /></button></div><p className="dialog-description">{existing ? "Mantenha as informações e os acessos da equipe atualizados." : "Cadastre uma pessoa para autorizar seu acesso ao Prevision."}</p><form className="access-form" onSubmit={submit}><div className="form-field"><label htmlFor="user-name">Nome</label><input autoFocus id="user-name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required disabled={busy} /></div><div className="form-field"><label htmlFor="user-email">E-mail</label><input id="user-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required disabled={busy || !!existing} />{existing && <p className="field-hint">O e-mail de identificação é preservado neste cadastro.</p>}</div>{canManageRoles ? <div className="form-field"><label htmlFor="user-role">Perfil de acesso</label><select id="user-role" value={role} onChange={(event) => setRole(event.target.value as WorkspaceIdentity["role"])} disabled={busy}>{roles.map((item) => <option key={item.code} value={item.code}>{item.name || roleLabels[item.code]}</option>)}</select></div> : <div className="readonly-field"><span>Perfil de acesso</span><strong>{roleLabels[role]}</strong></div>}<label className="checkbox-field"><input type="checkbox" checked={googleAccessAllowed} onChange={(event) => setGoogleAccessAllowed(event.target.checked)} disabled={busy} /><span><strong>Permitir acesso com Google</strong><span>O usuário precisará vincular a própria conta para usar essa opção.</span></span></label>{existing && <label className="checkbox-field"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} disabled={busy} /><span><strong>Usuário ativo</strong><span>Desativar impede o acesso deste usuário ao sistema.</span></span></label>}{error && <p className="form-message form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="button-secondary" onClick={() => dialogRef.current?.close()} disabled={busy}>Cancelar</button><button className="button-primary" type="submit" disabled={busy}>{busy ? "Salvando…" : existing ? "Salvar alterações" : "Cadastrar e enviar ativação"}</button></div></form></div></dialog>;
}

function PasswordResetDialog({ user, emailDelivery, onClose, onSent }: {
  user: ManagedUser;
  emailDelivery: "local" | "smtp";
  onClose: () => void;
  onSent: (message: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const submittingRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true); setError("");
    try {
      const result = await sendJson<{ sent: boolean }>(`/api/users/${encodeURIComponent(user.id)}/password-reset`, {});
      if (result?.sent !== true) throw new Error("Não foi possível confirmar o envio das instruções. Tente novamente.");
      onSent(emailDelivery === "local"
        ? `Instruções de redefinição geradas na caixa de mensagens local para ${user.email}.`
        : `Instruções de redefinição enviadas para ${user.email}.`);
    } catch (failure) { setError(errorMessage(failure)); setBusy(false); }
    finally { submittingRef.current = false; }
  }

  return <dialog className="user-dialog" ref={dialogRef} aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy}
    onClose={onClose} onCancel={(event) => { if (busy) event.preventDefault(); }}
    onClick={(event) => { if (event.target === event.currentTarget && !busy) dialogRef.current?.close(); }}>
    <div className="user-dialog-content">
      <div className="dialog-heading"><div><p className="eyebrow">AÇÃO DO ADMINISTRADOR</p><h2 id={titleId}>Redefinir senha</h2></div><button className="icon-button" type="button" aria-label="Fechar confirmação" disabled={busy} onClick={() => dialogRef.current?.close()}><Icon name="close" /></button></div>
      <form className="access-form" onSubmit={submit}>
        <p id={descriptionId} className="dialog-description" style={{ overflowWrap: "anywhere" }}>Gerar instruções para <strong>{user.name || user.email}</strong>, no e-mail <strong>{user.email}</strong>?</p>
        <p className="field-hint">O usuário receberá um link válido por 30 minutos, de uso único, para escolher a própria senha.</p>
        <p className="field-hint">A senha atual só será substituída quando o usuário salvar a nova senha. Nesse momento, as sessões anteriores serão encerradas.</p>
        {!user.isActive && <p className="form-message form-error">Este usuário está inativo. A redefinição da senha preserva essa situação e não reativa o acesso.</p>}
        {user.googleLinked && <p className="field-hint">O vínculo com Google será preservado. Contas que usam Google também poderão definir uma senha para entrar no Prevision.</p>}
        {emailDelivery === "local" && <p className="form-message form-success">O envio pela internet não está configurado neste ambiente. As instruções serão salvas na caixa de mensagens local.</p>}
        {error && <p className="form-message form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="button-secondary" type="button" autoFocus disabled={busy} onClick={() => dialogRef.current?.close()}>Cancelar</button><button className="button-primary" type="submit" disabled={busy}>{busy ? "Gerando instruções…" : emailDelivery === "local" ? "Gerar instruções" : "Enviar instruções"}</button></div>
      </form>
    </div>
  </dialog>;
}

export function UsersManager({ canManageRoles, canResetPassword, emailDelivery }: { canManageRoles: boolean; canResetPassword: boolean; emailDelivery: "local" | "smtp" }) {
  const [data, setData] = useState<UsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<UserDialogState | null>(null);
  const [resetUser, setResetUser] = useState<ManagedUser | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/users", { credentials: "same-origin", cache: "no-store", signal });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message || "Não foi possível consultar os usuários.");
      if (!Array.isArray(result?.users) || !Array.isArray(result?.roles)) throw new Error("Não foi possível carregar a lista de usuários. Tente novamente.");
      setData(result as UsersResponse);
    } catch (failure) { if (!(failure instanceof DOMException && failure.name === "AbortError")) setError(errorMessage(failure)); } finally { if (!signal?.aborted) setLoading(false); }
  }, []);

  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  async function resend(user: ManagedUser) {
    setResending(user.id); setError(""); setNotice("");
    try { const result = await sendJson(`/api/users/${encodeURIComponent(user.id)}/activation`, {}); setNotice(result?.message || "Solicitação de ativação concluída. Oriente o usuário a conferir suas mensagens."); } catch (failure) { setError(errorMessage(failure)); } finally { setResending(null); }
  }

  const filtered = data?.users.filter((user) => `${user.name || ""} ${user.email}`.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR"))) || [];

  return <><div className="management-toolbar"><div className="user-search"><label className="sr-only" htmlFor="user-search">Pesquisar por nome ou e-mail</label><input id="user-search" type="search" placeholder="Pesquisar por nome ou e-mail" value={search} onChange={(event) => setSearch(event.target.value)} disabled={!data} /></div><button className="button-primary" type="button" disabled={!data || loading} onClick={() => { setNotice(""); setDialog({ mode: "create" }); }}>Adicionar usuário<Icon name="partners" /></button></div>{notice && <p className="form-message form-success" role="status">{notice}</p>}{error && <div className="form-message form-error" role="alert"><p>{error}</p><button type="button" className="text-link" disabled={loading} onClick={() => void load()}>Tentar consultar novamente</button></div>}<section className="management-panel" aria-labelledby="user-list-title" aria-busy={loading}><div className="panel-heading"><div><h2 id="user-list-title">Pessoas com acesso ao ambiente</h2><p>O acesso é individual e depende da autorização do administrador.</p></div>{data && <span className="count-badge">{data.users.length} {data.users.length === 1 ? "usuário" : "usuários"}</span>}</div>{loading && !data ? <p className="table-state" role="status">Consultando usuários…</p> : data && filtered.length ? <div className="table-scroll"><table className="users-table"><thead><tr><th scope="col">Usuário</th><th scope="col">Perfil</th><th scope="col">Situação</th><th scope="col">Google</th><th scope="col"><span className="sr-only">Ações</span></th></tr></thead><tbody>{filtered.map((user) => <tr key={user.id}><td><div className="user-cell"><span className="user-initial" aria-hidden="true">{(user.name || user.email).slice(0, 1).toLocaleUpperCase("pt-BR")}</span><span><strong>{user.name || "Nome não informado"}</strong><span>{user.email}</span></span></div></td><td><span className="role-badge">{roleLabels[user.role]}</span></td><td><span className={`status-pill ${user.isActive ? "status-active" : "status-inactive"}`}><span />{user.isActive ? "Ativo" : "Inativo"}</span></td><td><div className="google-status">{user.googleLinked ? "Vinculado" : "Não vinculado"}<span>{user.googleAccessAllowed ? "Acesso permitido" : "Acesso desabilitado"}</span></div></td><td><div className="row-actions"><button className="text-link" type="button" onClick={() => { setNotice(""); setDialog({ mode: "edit", user }); }} aria-label={`Editar ${user.name || user.email}`}>Editar</button><button className="text-link" type="button" disabled={!!resending} onClick={() => void resend(user)} aria-label={`Reenviar ativação para ${user.name || user.email}`}>{resending === user.id ? "Enviando…" : "Reenviar ativação"}</button>{canResetPassword && <button className="text-link" type="button" disabled={!!resending} onClick={() => { setNotice(""); setError(""); setResetUser(user); }} aria-label={`Redefinir senha de ${user.name || user.email}`}>Redefinir senha</button>}</div></td></tr>)}</tbody></table></div> : data ? <div className="table-state"><Icon name="partners" /><strong>{search ? "Nenhum usuário encontrado" : "Ainda não há usuários para exibir"}</strong><p>{search ? "Tente pesquisar por outro nome ou e-mail." : "Adicione um usuário para autorizar o acesso ao ambiente."}</p></div> : !loading && <p className="table-state">A lista de usuários não está disponível.</p>}</section><p className="management-footnote"><Icon name="shield" /> Cada pessoa utiliza seu próprio acesso. Para ativar a conta, oriente o usuário a conferir as instruções recebidas ou falar com o administrador.</p>{dialog && data && <UserDialog state={dialog} roles={data.roles} canManageRoles={canManageRoles} onClose={() => setDialog(null)} onSaved={(message) => { setDialog(null); setNotice(message); void load(); }} />}{canResetPassword && resetUser && <PasswordResetDialog user={resetUser} emailDelivery={emailDelivery} onClose={() => setResetUser(null)} onSent={(message) => { setResetUser(null); setError(""); setNotice(message); }} />}</>;
}
