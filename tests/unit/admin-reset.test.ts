import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestAdminPasswordReset } from "../../src/server/users/password-reset.ts";
import { confirmPassword, hashAccessToken, requestPasswordReset } from "../../src/server/auth/access-tokens.ts";
import { deliverAccessEmail } from "../../src/server/mail/delivery.ts";
import { hashPassword } from "../../src/server/security/password.ts";
import type { Principal } from "../../src/server/auth/identity.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown> }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));
vi.mock("../../src/server/mail/delivery.ts", () => ({ deliverAccessEmail: vi.fn() }));
vi.mock("../../src/server/security/password.ts", async (original) => ({
  ...await original<typeof import("../../src/server/security/password.ts")>(),
  hashPassword: vi.fn()
}));

const administratorId = "00000000-0000-4000-8000-000000000001";
const targetId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const tokenId = "00000000-0000-4000-8000-000000000004";
const storedToken = "a".repeat(43);
const newPassword = "nova senha apenas para teste";

function fixture() {
  const actor: Principal = {
    id: administratorId, sessionId, sessionVersion: 1, name: "Administrador", email: "admin@example.invalid",
    role: "ADMINISTRATOR", permissions: ["users.manage"], hasPassword: true, googleLinked: false, googleAccessAllowed: false
  };
  const administrator = {
    id: administratorId, name: actor.name, email: actor.email, isActive: true, sessionVersion: 1,
    passwordHash: "old-administrator-hash", googleAccessAllowed: false, accounts: [],
    role: { code: "ADMINISTRATOR", permissions: [{ permission: { code: "users.manage" } }] }
  };
  const target = { id: targetId, email: "target@example.invalid", isActive: true, passwordHash: "old-target-hash" as string | null, googleAccessAllowed: true };
  const session = { id: sessionId, user: administrator, sessionVersion: 1, revokedAt: null as Date | null, expiresAt: new Date(Date.now() + 3600000), lastSeenAt: new Date(), createdAt: new Date() };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) => where.id === administratorId ? administrator : where.id === targetId || where.email === target.email ? target : null),
      update: vi.fn().mockResolvedValue(target)
    },
    loginSession: { findUnique: vi.fn().mockResolvedValue(session), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    accessToken: { create: vi.fn().mockResolvedValue({ id: tokenId }), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    auditEvent: { create: vi.fn().mockResolvedValue({}) }
  };
  const database = { ...tx, $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)) };
  state.database = database;
  const candidate = (purpose = "ADMIN_PASSWORD_RESET") => ({ id: tokenId, userId: targetId, tokenHash: hashAccessToken(storedToken), purpose, usedAt: null, revokedAt: null, expiresAt: new Date(Date.now() + 1800000), user: target });
  return { actor, administrator, target, session, tx, database, candidate };
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "segredo-apenas-para-testes-unitarios-00000001");
  vi.stubEnv("AUTH_URL", "http://127.0.0.1:3000");
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("MAIL_TRANSPORT", "local");
  vi.mocked(deliverAccessEmail).mockReset().mockResolvedValue(undefined);
  vi.mocked(hashPassword).mockReset().mockResolvedValue("new-password-hash");
});
afterEach(() => vi.unstubAllEnvs());

describe("solicitação administrativa de redefinição", () => {
  it.each(["MANAGER", "OPERATOR"] as const)("recusa %s mesmo com users.manage", async (role) => {
    const { actor, database, tx } = fixture();
    actor.role = role;
    await expect(requestAdminPasswordReset(actor, targetId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(tx.accessToken.create).not.toHaveBeenCalled();
    expect(deliverAccessEmail).not.toHaveBeenCalled();
  });

  it("exige também a permissão de gerenciamento", async () => {
    const { actor, tx } = fixture();
    actor.permissions = [];
    await expect(requestAdminPasswordReset(actor, targetId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.accessToken.create).not.toHaveBeenCalled();
  });

  it("revalida o papel depois de aguardar o lock", async () => {
    const { actor, administrator, tx } = fixture();
    tx.$executeRaw.mockImplementation(async () => { administrator.role.code = "MANAGER"; return 1; });
    await expect(requestAdminPasswordReset(actor, targetId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.accessToken.create).not.toHaveBeenCalled();
    expect(deliverAccessEmail).not.toHaveBeenCalled();
  });

  it("rejeita o administrador cuja sessão foi revogada durante a espera", async () => {
    const { actor, session, tx } = fixture();
    tx.$executeRaw.mockImplementation(async () => { session.revokedAt = new Date(); return 1; });
    await expect(requestAdminPasswordReset(actor, targetId)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.accessToken.create).not.toHaveBeenCalled();
  });

  it("grava só o hash, envia link de uso único e não expõe token na resposta ou auditoria", async () => {
    const { actor, target, tx, database } = fixture();
    const result = await requestAdminPasswordReset(actor, targetId);
    expect(result).toEqual({ sent: true });
    const body = vi.mocked(deliverAccessEmail).mock.calls[0][2];
    const url = new URL(body.match(/http:\/\/127\.0\.0\.1:3000\/[^\s]+/)![0]);
    const rawToken = url.searchParams.get("token")!;
    expect(url.pathname).toBe("/redefinir-senha");
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(vi.mocked(deliverAccessEmail).mock.calls[0][0]).toBe(target.email);
    const data = tx.accessToken.create.mock.calls[0][0].data;
    expect(data.purpose).toBe("ADMIN_PASSWORD_RESET");
    expect(data.tokenHash).toBe(hashAccessToken(rawToken));
    expect(data.expiresAt.getTime() - data.createdAt.getTime()).toBe(1800000);
    expect(JSON.stringify(tx.auditEvent.create.mock.calls)).not.toContain(rawToken);
    expect(JSON.stringify(tx.auditEvent.create.mock.calls)).not.toContain(data.tokenHash);
    expect(JSON.stringify(result)).not.toContain(rawToken);
    expect(tx.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actorId: administratorId, entityId: targetId, origin: "users.admin_password_reset" }) }));
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "ReadCommitted" }));
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.loginSession.updateMany).not.toHaveBeenCalled();
  });

  it.each(["Google exclusivo", "conta inativa"])("permite solicitar para %s sem ativar a conta ou trocar a senha imediatamente", async (kind) => {
    const { actor, target, tx } = fixture();
    target.passwordHash = null;
    target.isActive = kind !== "conta inativa";
    await expect(requestAdminPasswordReset(actor, targetId)).resolves.toEqual({ sent: true });
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.accessToken.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ purpose: "ADMIN_PASSWORD_RESET" }) }));
    expect(target.isActive).toBe(kind !== "conta inativa");
  });

  it("não emite token para um identificador inexistente", async () => {
    const { actor, tx } = fixture();
    await expect(requestAdminPasswordReset(actor, "00000000-0000-4000-8000-000000000099")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(tx.accessToken.create).not.toHaveBeenCalled();
    expect(deliverAccessEmail).not.toHaveBeenCalled();
  });

  it("revoga somente o token emitido nesta solicitação quando a entrega falha", async () => {
    const { actor, tx } = fixture();
    vi.mocked(deliverAccessEmail).mockRejectedValueOnce(new Error("smtp-sensitive-detail"));
    await expect(requestAdminPasswordReset(actor, targetId)).rejects.toMatchObject({ code: "UNAVAILABLE", message: "Não foi possível enviar as instruções de redefinição. Tente novamente." });
    expect(tx.accessToken.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: tokenId, userId: targetId, usedAt: null, revokedAt: null } }));
    expect(tx.auditEvent.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ origin: "users.admin_password_reset.delivery_failed", actorId: administratorId, entityId: targetId }) }));
    const requests = tx.auditEvent.create.mock.calls;
    expect(requests[0][0].data.operationId).toBe(requests[1][0].data.operationId);
    expect(JSON.stringify(requests)).not.toContain("smtp-sensitive-detail");
  });
});

describe("consumo do link administrativo", () => {
  it.each(["Google exclusivo", "conta inativa"])("define a senha de %s, revoga sessões e preserva estado e Google", async (kind) => {
    const { target, tx, candidate } = fixture();
    target.passwordHash = null;
    target.isActive = kind !== "conta inativa";
    tx.accessToken.findUnique.mockResolvedValue(candidate());
    await confirmPassword(storedToken, newPassword, "PASSWORD_RESET");
    expect(hashPassword).toHaveBeenCalledExactlyOnceWith(newPassword);
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: targetId }, data: { passwordHash: "new-password-hash", sessionVersion: { increment: 1 } } });
    expect(tx.loginSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: targetId, revokedAt: null } }));
    expect(tx.accessToken.updateMany.mock.calls[0][0].where.user).toBeUndefined();
    expect(target.googleAccessAllowed).toBe(true);
    expect(target.isActive).toBe(kind !== "conta inativa");
    expect(tx.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "PASSWORD_RESET", origin: "users.admin_password_reset.complete" }) }));
  });

  it.each(["Google exclusivo", "conta inativa"])("mantém a recuperação comum bloqueada para %s", async (kind) => {
    const { target, tx, candidate } = fixture();
    target.passwordHash = kind === "Google exclusivo" ? null : "old-target-hash";
    target.isActive = kind !== "conta inativa";
    tx.accessToken.findUnique.mockResolvedValue(candidate("PASSWORD_RESET"));
    await expect(confirmPassword(storedToken, newPassword, "PASSWORD_RESET")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(hashPassword).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("não aceita um link administrativo no fluxo de ativação", async () => {
    const { tx, candidate } = fixture();
    tx.accessToken.findUnique.mockResolvedValue(candidate());
    await expect(confirmPassword(storedToken, newPassword, "PASSWORD_SETUP")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("rejeita o segundo consumo se outra confirmação já utilizou o token", async () => {
    const { tx, candidate } = fixture();
    tx.accessToken.findUnique.mockResolvedValue(candidate());
    tx.accessToken.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(confirmPassword(storedToken, newPassword, "PASSWORD_RESET")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("a recuperação pública não emite uma redefinição administrativa para Google exclusivo", async () => {
    const { target, tx } = fixture();
    target.passwordHash = null;
    await requestPasswordReset(target.email);
    expect(tx.accessToken.create).not.toHaveBeenCalled();
    expect(deliverAccessEmail).not.toHaveBeenCalled();
  });

  it("um novo link comum substitui também links administrativos anteriores", async () => {
    const { target, tx } = fixture();
    await requestPasswordReset(target.email);
    expect(tx.accessToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ purpose: { in: ["PASSWORD_RESET", "ADMIN_PASSWORD_RESET"] } }) }));
    expect(tx.accessToken.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ purpose: "PASSWORD_RESET" }) }));
  });
});
