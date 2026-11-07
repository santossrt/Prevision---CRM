import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { AccessTokenPurpose } from "../../generated/prisma/enums.ts";
import type { Principal } from "./identity.ts";
import { identityInclude, principalFromSession } from "./identity.ts";
import { getDatabase } from "../database/client.ts";
import { verifyDatabaseIdentity } from "../database/identity.ts";
import { ApplicationError } from "../errors/application-error.ts";
import { deliverAccessEmail } from "../mail/delivery.ts";
import { hashPassword, passwordSchema, verifyPassword } from "../security/password.ts";
import { getAuthCapabilities, getAuthSettings, tokenSchema } from "./settings.ts";
import { lockAuthState } from "./sessions.ts";

export function hashAccessToken(token: string) { return createHash("sha256").update(token, "utf8").digest("hex"); }
const invalidLink = () => new ApplicationError("VALIDATION", "Link inválido, expirado ou já utilizado. Solicite um novo link.");

async function issueToken(userId: string, purpose: AccessTokenPurpose, seconds: number) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  return getDatabase().$transaction(async (tx) => {
    await lockAuthState(tx);
    const user = await tx.user.findUnique({ where: { id: userId }, include: { accounts: true } });
    if (!user?.isActive || (purpose === "PASSWORD_SETUP" && (user.passwordHash || user.accounts.length)) || (purpose === "PASSWORD_RESET" && !user.passwordHash)) return null;
    // A Google grant derived from an older activation must expire when that
    // activation is replaced, even if the OAuth round trip is still pending.
    const purposes = purpose === "PASSWORD_SETUP" ? [purpose, "GOOGLE_LINK"] as const
      : purpose === "PASSWORD_RESET" ? [purpose, "ADMIN_PASSWORD_RESET"] as const : [purpose];
    await tx.accessToken.updateMany({ where: { userId, purpose: { in: [...purposes] }, usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    await tx.accessToken.create({ data: { userId, purpose, tokenHash: hashAccessToken(token), expiresAt: new Date(now.getTime() + seconds * 1000) } });
    return token;
  });
}

export async function sendActivationEmail(userId: string) {
  await verifyDatabaseIdentity();
  const user = await getDatabase().user.findUnique({ where: { id: userId }, include: { accounts: true } });
  if (!user?.isActive) throw new ApplicationError("CONFLICT", "Ative o usuário antes de enviar um convite.");
  if (user.passwordHash || user.accounts.length) throw new ApplicationError("CONFLICT", "O usuário já ativou o acesso. Utilize a recuperação de senha quando necessário.");
  const token = await issueToken(user.id, "PASSWORD_SETUP", 86400);
  if (!token) throw new ApplicationError("CONFLICT", "O estado de acesso do usuário mudou. Atualize a página e tente novamente.");
  const url = new URL("/ativar-acesso", getAuthSettings().url);
  url.searchParams.set("token", token);
  await deliverAccessEmail(user.email, "Ative seu acesso ao Prevision", `Seu acesso foi autorizado. Defina sua senha ou vincule o Google, quando permitido:\n\n${url}\n\nEste link é válido por 24 horas e só pode ser utilizado uma vez. Se não esperava este convite, ignore esta mensagem.`);
}

export async function requestPasswordReset(email: string) {
  await verifyDatabaseIdentity();
  const user = await getDatabase().user.findUnique({ where: { email } });
  if (!user?.isActive || !user.passwordHash) return;
  const token = await issueToken(user.id, "PASSWORD_RESET", 1800);
  if (!token) return;
  const url = new URL("/redefinir-senha", getAuthSettings().url);
  url.searchParams.set("token", token);
  await deliverAccessEmail(user.email, "Redefina sua senha do Prevision", `Para definir uma nova senha, utilize:\n\n${url}\n\nO link expira em 30 minutos e possui uso único. Se não solicitou esta alteração, ignore a mensagem.`);
}

export async function confirmPassword(tokenInput: unknown, passwordInput: unknown, purpose: "PASSWORD_SETUP" | "PASSWORD_RESET") {
  const token = tokenSchema.safeParse(tokenInput);
  if (!token.success) throw invalidLink();
  const password = passwordSchema.parse(passwordInput);
  await verifyDatabaseIdentity();
  const db = getDatabase();
  const candidate = await db.accessToken.findUnique({ where: { tokenHash: hashAccessToken(token.data) }, include: { user: true } });
  const now = new Date();
  const administrativeReset = purpose === "PASSWORD_RESET" && candidate?.purpose === "ADMIN_PASSWORD_RESET";
  if (!candidate || (!administrativeReset && candidate.purpose !== purpose) || candidate.usedAt || candidate.revokedAt || candidate.expiresAt <= now
    || (!administrativeReset && (!candidate.user.isActive || (purpose === "PASSWORD_RESET" && !candidate.user.passwordHash)))) throw invalidLink();
  const passwordHash = await hashPassword(password);
  await db.$transaction(async (tx) => {
    await lockAuthState(tx);
    const user = await tx.user.findUnique({ where: { id: candidate.userId } });
    if (!user || (!administrativeReset && (!user.isActive || (purpose === "PASSWORD_RESET" && !user.passwordHash)))) throw invalidLink();
    const consumed = await tx.accessToken.updateMany({ where: { id: candidate.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() }, ...(!administrativeReset ? { user: { isActive: true } } : {}) }, data: { usedAt: new Date() } });
    if (consumed.count !== 1) throw invalidLink();
    await tx.user.update({ where: { id: candidate.userId }, data: { passwordHash, sessionVersion: { increment: 1 } } });
    await tx.loginSession.updateMany({ where: { userId: candidate.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.accessToken.updateMany({ where: { userId: candidate.userId, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.auditEvent.create({ data: { actorId: candidate.userId, action: purpose === "PASSWORD_SETUP" ? "PASSWORD_SETUP" : "PASSWORD_RESET", module: "AUTH", entityType: "User", entityId: candidate.userId,
      ...(administrativeReset ? { origin: "users.admin_password_reset.complete", newValues: { administrativeReset: true } } : {}) } });
  });
}

export async function prepareGoogleLink(principal: Principal | null, activationToken: unknown, password: unknown) {
  if (!getAuthCapabilities().google) throw new ApplicationError("UNAVAILABLE", "O login Google ainda não foi configurado.");
  await verifyDatabaseIdentity();
  const db = getDatabase();
  const fromActivation = typeof activationToken === "string";
  if (fromActivation && !tokenSchema.safeParse(activationToken).success) throw invalidLink();
  let verifiedPasswordHash: string | null = null;
  if (!fromActivation) {
    if (!principal) throw new ApplicationError("UNAUTHORIZED", "Entre novamente para continuar.");
    const user = await db.user.findUnique({ where: { id: principal.id } });
    if (!user?.isActive) throw new ApplicationError("UNAUTHORIZED", "Acesso não autorizado.");
    if (user.passwordHash && (typeof password !== "string" || !await verifyPassword(user.passwordHash, password))) throw new ApplicationError("UNAUTHORIZED", "Não foi possível confirmar sua senha.");
    verifiedPasswordHash = user.passwordHash;
  }
  const token = randomBytes(32).toString("base64url");
  return db.$transaction(async (tx) => {
    await lockAuthState(tx);
    let userId: string;
    let expiry = Date.now() + 10 * 60 * 1000;
    if (fromActivation) {
      const activation = await tx.accessToken.findUnique({ where: { tokenHash: hashAccessToken(activationToken as string) }, include: { user: true } });
      if (!activation || activation.purpose !== "PASSWORD_SETUP" || activation.usedAt || activation.revokedAt || activation.expiresAt.getTime() <= Date.now() || !activation.user.isActive) throw invalidLink();
      if (principal && principal.id !== activation.userId) throw new ApplicationError("CONFLICT", "Saia da conta atual antes de ativar outro usuário.");
      userId = activation.userId;
      expiry = Math.min(expiry, activation.expiresAt.getTime());
    } else {
      const session = await tx.loginSession.findUnique({ where: { id: principal!.sessionId }, include: identityInclude });
      const current = session && principalFromSession(session, { sub: principal!.id, version: principal!.sessionVersion });
      if (!current || session!.user.passwordHash !== verifiedPasswordHash) throw new ApplicationError("UNAUTHORIZED", "Entre novamente para continuar.");
      userId = current.id;
    }
    const user = await tx.user.findUnique({ where: { id: userId }, include: { accounts: true } });
    if (!user?.isActive || !user.googleAccessAllowed) throw new ApplicationError("FORBIDDEN", "A vinculação Google não foi autorizada pelo administrador.");
    if (user.accounts.some((account) => account.provider === "google")) throw new ApplicationError("CONFLICT", "Já existe uma conta Google vinculada.");
    const now = new Date();
    await tx.accessToken.updateMany({ where: { userId, purpose: "GOOGLE_LINK", usedAt: null, revokedAt: null }, data: { revokedAt: now } });
    await tx.accessToken.create({ data: { userId, purpose: "GOOGLE_LINK", tokenHash: hashAccessToken(token), expiresAt: new Date(expiry) } });
    return token;
  });
}

export async function authorizeGoogleIdentity(proof: { subject: string; email: string; verified: boolean }, grantToken?: string, currentUserId?: string) {
  await verifyDatabaseIdentity();
  if (!proof.verified || !proof.subject || !proof.email) return null;
  const db = getDatabase();
  const linked = await db.account.findUnique({ where: { provider_providerAccountId: { provider: "google", providerAccountId: proof.subject } }, include: { user: true } });
  if (linked) return linked.user.isActive && linked.user.googleAccessAllowed && (!currentUserId || currentUserId === linked.userId) ? linked.user : null;
  if (!tokenSchema.safeParse(grantToken).success) return null;
  const tokenHash = hashAccessToken(grantToken!);
  return db.$transaction(async (tx) => {
    await lockAuthState(tx);
    const grant = await tx.accessToken.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!grant || grant.purpose !== "GOOGLE_LINK" || grant.usedAt || grant.revokedAt || grant.expiresAt.getTime() <= Date.now() || !grant.user.isActive || !grant.user.googleAccessAllowed || grant.user.email !== proof.email.trim().toLowerCase() || (currentUserId && currentUserId !== grant.userId)) return null;
    const used = await tx.accessToken.updateMany({ where: { id: grant.id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (used.count !== 1) return null;
    if (await tx.account.findFirst({ where: { userId: grant.userId, provider: "google" } })) throw new ApplicationError("CONFLICT", "Já existe uma conta Google vinculada.");
    await tx.account.create({ data: { userId: grant.userId, type: "oidc", provider: "google", providerAccountId: proof.subject } });
    await tx.accessToken.updateMany({ where: { userId: grant.userId, purpose: "PASSWORD_SETUP", usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.auditEvent.create({ data: { actorId: grant.userId, action: "UPDATE", module: "AUTH", entityType: "User", entityId: grant.userId, newValues: { googleLinked: true } } });
    return grant.user;
  });
}
