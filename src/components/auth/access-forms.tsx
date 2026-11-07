"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useState, type FormEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { PasswordField } from "./password-field";
import { errorMessage, sendJson } from "./client-api";

const genericLoginError = "Não foi possível entrar. Confira seus dados e a autorização de acesso, ou fale com o administrador.";

function GoogleButton({ children = "Continuar com Google", busy, disabled, onClick }: { children?: string; busy: boolean; disabled: boolean; onClick: () => void }) {
  return <button type="button" className="button-google" disabled={disabled} onClick={onClick}><span className="google-mark" aria-hidden="true">G</span>{busy ? "Conectando…" : children}</button>;
}

export function LoginForm({ googleAvailable, initialError = false }: { googleAvailable: boolean; initialError?: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "google" | null>(null);
  const [error, setError] = useState(initialError ? genericLoginError : "");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setBusy("password");
    try {
      const result = await signIn("credentials", { redirect: false, email: email.trim(), password });
      if (!result || result.error) { setError(genericLoginError); return; }
      router.replace("/"); router.refresh();
    } catch { setError(genericLoginError); } finally { setBusy(null); }
  }

  async function google() {
    setError(""); setBusy("google");
    try { await signIn("google", { redirectTo: "/" }); } catch { setError(genericLoginError); setBusy(null); }
  }

  return <><form className="access-form" onSubmit={submit}><div className="form-field"><label htmlFor="login-email">E-mail</label><input id="login-email" type="email" autoComplete="username" placeholder="seuemail@empresa.com.br" value={email} onChange={(event) => setEmail(event.target.value)} required maxLength={254} disabled={!!busy} /></div><PasswordField id="login-password" label="Senha" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required maxLength={128} disabled={!!busy} /><div className="form-link-row"><Link href="/recuperar-senha" className="text-link">Esqueci minha senha</Link></div>{error && <p className="form-message form-error" role="alert">{error}</p>}<button className="button-primary" disabled={!!busy} type="submit">{busy === "password" ? "Entrando…" : "Entrar no Prevision"}<Icon name="arrow-right" /></button></form>{googleAvailable ? <><div className="form-divider"><span />ou<span /></div><GoogleButton busy={busy === "google"} disabled={!!busy} onClick={() => void google()} /></> : <p className="access-support-note">O acesso com Google não está disponível neste ambiente. Para habilitá-lo, fale com o administrador.</p>}<p className="access-invitation-note">Ainda não tem acesso? Peça ao administrador para cadastrar seu usuário e enviar um link de ativação.</p></>;
}

export function PasswordResetRequestForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { await sendJson("/api/access/password-reset/request", { email: email.trim() }); setComplete(true); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }

  if (complete) return <div className="form-complete"><span className="complete-icon"><Icon name="check" /></span><h2>Confira suas mensagens</h2><p>Se o e-mail informado estiver apto à recuperação, você receberá as instruções para definir uma nova senha.</p><p>Confira também a pasta de spam. Se precisar de ajuda, fale com o administrador.</p><Link className="button-primary" href="/login">Voltar para o acesso<Icon name="arrow-right" /></Link></div>;
  return <><form className="access-form" onSubmit={submit}><div className="form-field"><label htmlFor="recovery-email">E-mail</label><input id="recovery-email" type="email" autoComplete="email" placeholder="seuemail@empresa.com.br" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} required disabled={busy} /></div>{error && <p className="form-message form-error" role="alert">{error}</p>}<button type="submit" className="button-primary" disabled={busy}>{busy ? "Enviando…" : "Enviar instruções"}<Icon name="arrow-right" /></button></form><p className="access-support-note">Se você entra exclusivamente com Google, recupere o acesso pela sua própria conta Google.</p></>;
}

export function SetPasswordForm({ token, mode, googleAvailable = false }: { token: string; mode: "reset" | "activation"; googleAvailable?: boolean }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"password" | "google" | null>(null);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (password !== confirmation) { setError("As senhas precisam ser iguais."); return; }
    setBusy("password");
    try { await sendJson(mode === "reset" ? "/api/access/password-reset/confirm" : "/api/access/activate", { token, password }); setPassword(""); setConfirmation(""); setComplete(true); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(null); }
  }

  async function google() {
    setError(""); setBusy("google");
    try { await sendJson("/api/access/google-link", { activationToken: token }); await signIn("google", { redirectTo: "/perfil" }); } catch (failure) { setError(errorMessage(failure)); setBusy(null); }
  }

  if (!token) return <div className="form-message form-error" role="alert"><strong>Este link está incompleto.</strong><p>{mode === "reset" ? "Solicite novas instruções de recuperação para continuar." : "Peça ao administrador um novo link de ativação."}</p><Link className="text-link" href={mode === "reset" ? "/recuperar-senha" : "/login"}>{mode === "reset" ? "Solicitar novo link" : "Voltar para o acesso"}</Link></div>;
  if (complete) return <div className="form-complete" role="status"><span className="complete-icon"><Icon name="check" /></span><h2>{mode === "reset" ? "Senha atualizada" : "Acesso ativado"}</h2><p>{mode === "reset" ? "Sua senha foi salva e as sessões anteriores foram encerradas. Se seu acesso estiver inativo, fale com o administrador para liberar o acesso." : "Agora você pode entrar no Prevision com seu e-mail e a senha que acabou de definir."}</p><Link className="button-primary" href="/login">Ir para o acesso<Icon name="arrow-right" /></Link></div>;
  return <><form className="access-form" onSubmit={submit}><PasswordField id="new-password" label={mode === "reset" ? "Nova senha" : "Defina sua senha"} hint="Use de 12 a 128 caracteres. Prefira uma senha longa e exclusiva para este acesso." autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required disabled={!!busy} /><PasswordField id="confirm-password" label="Confirme a senha" autoComplete="new-password" minLength={12} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required disabled={!!busy} />{error && <p className="form-message form-error" role="alert">{error}</p>}<button className="button-primary" type="submit" disabled={!!busy}>{busy === "password" ? "Salvando…" : mode === "reset" ? "Salvar nova senha" : "Ativar meu acesso"}<Icon name="arrow-right" /></button></form>{mode === "activation" && (googleAvailable ? <><div className="form-divider"><span />ou<span /></div><GoogleButton busy={busy === "google"} disabled={!!busy} onClick={() => void google()} /><p className="access-support-note">O vínculo com Google será concluído se essa forma de acesso estiver autorizada para sua conta.</p></> : <p className="access-support-note">O acesso com Google não está disponível neste ambiente. Você pode ativar o acesso definindo uma senha.</p>)}</>;
}

export function GoogleConnection({ hasPassword, googleLinked, googleAccessAllowed, googleAvailable }: { hasPassword: boolean; googleLinked: boolean; googleAccessAllowed: boolean; googleAvailable: boolean }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try { await sendJson("/api/access/google-link", { password }); setPassword(""); await signIn("google", { redirectTo: "/perfil" }); } catch (failure) { setError(errorMessage(failure)); setBusy(false); }
  }

  if (googleLinked) return <div className="connection-state"><span className="complete-icon"><Icon name="check" /></span><div><strong>Conta Google vinculada</strong><p>{!googleAvailable ? "O vínculo está preservado. O acesso com Google não está disponível neste ambiente." : googleAccessAllowed ? "Você também pode usar o Google para entrar no Prevision." : "O vínculo existe, mas o acesso com Google está desabilitado pelo administrador."}</p></div></div>;
  if (!googleAccessAllowed) return <p className="profile-description">O acesso com Google não está habilitado para sua conta. Se precisar dessa opção, fale com o administrador.</p>;
  if (!googleAvailable) return <p className="profile-description">O acesso com Google não está disponível neste ambiente. Fale com o administrador para verificar a configuração.</p>;
  if (!hasPassword) return <p className="profile-description">Para concluir o vínculo com Google, use o link de ativação recebido por e-mail. Se precisar de um novo link, fale com o administrador.</p>;
  return <form className="profile-link-form" onSubmit={submit}><p className="profile-description">Confirme sua senha atual para conectar sua conta Google ao seu usuário do Prevision.</p><PasswordField id="link-password" label="Senha atual" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={128} required disabled={busy} />{error && <p className="form-message form-error" role="alert">{error}</p>}<button className="button-google" disabled={busy} type="submit"><span className="google-mark" aria-hidden="true">G</span>{busy ? "Conectando…" : "Vincular conta Google"}</button></form>;
}
