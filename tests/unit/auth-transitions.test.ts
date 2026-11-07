import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoginSession } from "../../src/server/auth/sessions.ts";
import { authorizeGoogleIdentity, prepareGoogleLink, sendActivationEmail } from "../../src/server/auth/access-tokens.ts";
import type { Principal } from "../../src/server/auth/identity.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown> }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));
vi.mock("../../src/server/mail/delivery.ts", () => ({ deliverAccessEmail: vi.fn() }));
vi.mock("../../src/server/security/password.ts", async (original) => ({
  ...await original<typeof import("../../src/server/security/password.ts")>(),
  verifyPassword: vi.fn().mockResolvedValue(true)
}));

const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const token = "a".repeat(43);
const principal: Principal = {
  id: userId, sessionId, sessionVersion: 4, name: "Operador", email: "operador@example.invalid",
  role: "OPERATOR", permissions: [], googleLinked: false, hasPassword: true, googleAccessAllowed: true
};

function fixture() {
  const user = {
    id: userId, email: principal.email, isActive: true, passwordHash: "hash-verificado", sessionVersion: 4,
    googleAccessAllowed: true, accounts: [] as { provider: string }[],
    role: { code: "OPERATOR", permissions: [] }
  };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    user: { findUnique: vi.fn().mockResolvedValue(user) },
    account: { findFirst: vi.fn().mockResolvedValue({ id: "conta-google" }), findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    loginSession: {
      findUnique: vi.fn().mockResolvedValue({ id: sessionId, user, sessionVersion: 4, revokedAt: null, expiresAt: new Date(Date.now() + 3600000), lastSeenAt: new Date() }),
      create: vi.fn().mockResolvedValue({ id: sessionId, sessionVersion: 4 })
    },
    accessToken: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn().mockResolvedValue({}) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) }
  };
  const database = { ...tx, $transaction: vi.fn(async (work: (database: typeof tx) => unknown) => work(tx)) };
  state.database = database;
  return { user, tx, database };
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "segredo-apenas-para-teste-unitario-00000001");
  vi.stubEnv("AUTH_URL", "http://127.0.0.1:3000");
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("MAIL_TRANSPORT", "local");
  vi.stubEnv("GOOGLE_CLIENT_ID", "cliente-unitario");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "segredo-unitario");
});
afterEach(() => vi.unstubAllEnvs());

describe("transições de autorização durante login", () => {
  it("recusa uma senha verificada antes de a versão da sessão mudar", async () => {
    const { tx, user } = fixture();
    tx.$executeRaw.mockImplementation(async () => { user.sessionVersion = 5; return 1; });
    await expect(createLoginSession(userId, "credentials", "teste", 4)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.loginSession.create).not.toHaveBeenCalled();
  });

  it("exige o snapshot da autorização de senha para emitir a sessão", async () => {
    const { tx } = fixture();
    await expect(createLoginSession(userId, "credentials", "teste")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.loginSession.create).not.toHaveBeenCalled();
  });

  it("recusa login Google quando o administrador o desautoriza antes de emitir a sessão", async () => {
    const { tx, user } = fixture();
    tx.$executeRaw.mockImplementation(async () => { user.googleAccessAllowed = false; return 1; });
    await expect(createLoginSession(userId, "google", "teste")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.loginSession.create).not.toHaveBeenCalled();
  });

  it("exige uma conta Google já vinculada mesmo com permissão administrativa", async () => {
    const { tx } = fixture();
    tx.account.findFirst.mockResolvedValue(null as never);
    await expect(createLoginSession(userId, "google", "teste")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.loginSession.create).not.toHaveBeenCalled();
  });

  it("emite a sessão por senha quando a autorização permanece válida", async () => {
    const { tx } = fixture();
    await expect(createLoginSession(userId, "credentials", "teste", 4)).resolves.toMatchObject({ sessionVersion: 4 });
    expect(tx.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "LOGIN_SUCCESS" }) }));
  });
});

describe("convites e concessões de vinculação Google", () => {
  it("invalida a concessão Google anterior ao substituir o convite de ativação", async () => {
    const { tx, user } = fixture();
    user.passwordHash = null as never;
    await sendActivationEmail(userId);
    expect(tx.accessToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId, purpose: { in: ["PASSWORD_SETUP", "GOOGLE_LINK"] } })
    }));
  });

  it("não prepara concessão a partir de convite revogado enquanto aguardava a transação", async () => {
    const { tx, user } = fixture();
    tx.accessToken.findUnique.mockResolvedValue({ id: "convite", userId, user, purpose: "PASSWORD_SETUP", revokedAt: new Date(), usedAt: null, expiresAt: new Date(Date.now() + 60000) });
    await expect(prepareGoogleLink(null, token, undefined)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(tx.accessToken.create).not.toHaveBeenCalled();
  });

  it("não prepara concessão quando a sessão foi revogada durante a confirmação de senha", async () => {
    const { tx, user } = fixture();
    tx.loginSession.findUnique.mockResolvedValue({ id: sessionId, user, sessionVersion: 4, revokedAt: new Date(), expiresAt: new Date(Date.now() + 3600000), lastSeenAt: new Date() });
    await expect(prepareGoogleLink(principal, undefined, "senha-de-teste-suficiente")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.accessToken.create).not.toHaveBeenCalled();
  });

  it("não prepara concessão quando a senha foi redefinida durante sua confirmação", async () => {
    const { tx, user } = fixture();
    tx.$executeRaw.mockImplementation(async () => { user.passwordHash = "hash-novo"; return 1; });
    await expect(prepareGoogleLink(principal, undefined, "senha-de-teste-suficiente")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.accessToken.create).not.toHaveBeenCalled();
  });

  it("recusa uma concessão Google revogada sem criar conta ou consumir a concessão", async () => {
    const { tx, user } = fixture();
    tx.accessToken.findUnique.mockResolvedValue({ id: "concessao", userId, user, purpose: "GOOGLE_LINK", usedAt: null, revokedAt: new Date(), expiresAt: new Date(Date.now() + 60000) });
    await expect(authorizeGoogleIdentity({ subject: "identidade-google", email: user.email, verified: true }, token)).resolves.toBeNull();
    expect(tx.account.create).not.toHaveBeenCalled();
    expect(tx.accessToken.updateMany).not.toHaveBeenCalled();
  });
});
