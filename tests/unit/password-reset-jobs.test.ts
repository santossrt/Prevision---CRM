import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptResetJobEmail, decryptResetJobEmail } from "../../src/server/mail/job-crypto.ts";
import { enqueuePasswordReset, processPasswordResetJobs } from "../../src/server/auth/password-reset-jobs.ts";
import { requestPasswordReset } from "../../src/server/auth/access-tokens.ts";
import { verifyDatabaseIdentity } from "../../src/server/database/identity.ts";
import { readJson } from "../../src/server/security/http.ts";
import { consumeRateLimit } from "../../src/server/security/rate-limit.ts";
import { POST } from "../../src/app/api/access/password-reset/request/route.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown>, callbacks: [] as (() => Promise<void>)[] }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: vi.fn() }));
vi.mock("../../src/server/auth/access-tokens.ts", () => ({ requestPasswordReset: vi.fn() }));
vi.mock("../../src/server/security/rate-limit.ts", () => ({ consumeRateLimit: vi.fn() }));
vi.mock("../../src/server/security/http.ts", () => ({
  readJson: vi.fn(), limitRequest: vi.fn(),
  errorResponse: () => Response.json({ message: "Operação indisponível." }, { status: 503 })
}));
vi.mock("next/server", () => ({ after: (callback: () => Promise<void>) => { state.callbacks.push(callback); } }));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));

const id = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const lockId = "00000000-0000-4000-8000-000000000003";
const email = "recipient@example.invalid";
const secret = "private-test-only-reset-queue-secret-000000000001";
type RawCall = [TemplateStringsArray, ...unknown[]];
const sqlText = (call: RawCall) => call[0].join("?");

function fixture() {
  const tx = { $executeRaw: vi.fn().mockResolvedValue(1), $queryRaw: vi.fn().mockResolvedValue([]) };
  const database = { ...tx, $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)) };
  state.database = database;
  return { tx, database, statements: () => (tx.$executeRaw.mock.calls as unknown as RawCall[]).map(sqlText) };
}
const job = (attempts = 1, payload = encryptResetJobEmail(id, email)) => ({ id, payload, lockedBy: lockId, attempts });

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", secret); vi.stubEnv("DATABASE_ID", "reset-queue-test-database");
  state.callbacks = [];
  vi.mocked(requestPasswordReset).mockReset().mockResolvedValue(undefined);
  vi.mocked(verifyDatabaseIdentity).mockReset().mockResolvedValue(undefined);
  vi.mocked(consumeRateLimit).mockReset().mockResolvedValue({ allowed: true, retryAfter: 0 });
  vi.mocked(readJson).mockReset().mockResolvedValue({ email });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("cifra dos pedidos de recuperação", () => {
  it("usa nonce aleatório e não armazena endereço ou token legíveis", () => {
    const first = encryptResetJobEmail(id, "Recipient@EXAMPLE.INVALID");
    const second = encryptResetJobEmail(id, email);
    expect(first).not.toBe(second); expect(first).not.toContain(email);
    expect(decryptResetJobEmail(id, first)).toBe(email);
    expect(decryptResetJobEmail(id, second)).toBe(email);
  });

  it.each(["nonce", "tag", "ciphertext"])("recusa adulteração de %s sem expor o conteúdo", (component) => {
    const parts = encryptResetJobEmail(id, email).split(".");
    const index = component === "nonce" ? 1 : component === "tag" ? 2 : 3;
    parts[index] = (parts[index][0] === "A" ? "B" : "A") + parts[index].slice(1);
    try { decryptResetJobEmail(id, parts.join(".")); throw new Error("O teste precisa recusar a adulteração."); }
    catch (error) { expect(error).toMatchObject({ code: "UNAVAILABLE" }); expect(String(error)).not.toContain(email); expect(String(error)).not.toContain(parts.join(".")); }
  });

  it("vincula o envelope ao pedido, banco e segredo do ambiente", () => {
    const payload = encryptResetJobEmail(id, email);
    expect(() => decryptResetJobEmail(otherId, payload)).toThrow();
    vi.stubEnv("DATABASE_ID", "other-database"); expect(() => decryptResetJobEmail(id, payload)).toThrow();
    vi.stubEnv("DATABASE_ID", "reset-queue-test-database"); vi.stubEnv("AUTH_SECRET", secret + "changed");
    expect(() => decryptResetJobEmail(id, payload)).toThrow();
  });

  it.each(["v0.bad.bad.bad", "v1.A.A.A", "v1." + "a".repeat(1600), ""])("recusa envelope inválido", (payload) => {
    expect(() => decryptResetJobEmail(id, payload)).toThrow("Não foi possível processar");
  });

  it("falha fechada sem chave ou identidade de banco", () => {
    vi.stubEnv("AUTH_SECRET", "short"); expect(() => encryptResetJobEmail(id, email)).toThrow();
    vi.stubEnv("AUTH_SECRET", secret); vi.stubEnv("DATABASE_ID", ""); expect(() => encryptResetJobEmail(id, email)).toThrow();
  });
});

describe("fila durável e processamento", () => {
  it("enfileira endereços elegíveis e desconhecidos pelo mesmo caminho sem consultar usuário ou SMTP", async () => {
    const { tx, database, statements } = fixture(); tx.$queryRaw.mockResolvedValue([{ count: 0 }]);
    const first = await enqueuePasswordReset(email); const second = await enqueuePasswordReset("unknown@example.invalid");
    expect(first).not.toBe(second); expect(verifyDatabaseIdentity).toHaveBeenCalledTimes(2);
    expect(requestPasswordReset).not.toHaveBeenCalled();
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "ReadCommitted" }));
    const inserts = (tx.$executeRaw.mock.calls as unknown as RawCall[]).filter((call) => sqlText(call).includes("INSERT INTO public.password_reset_jobs"));
    expect(inserts).toHaveLength(2);
    expect(decryptResetJobEmail(first, inserts[0][2] as string)).toBe(email);
    expect(decryptResetJobEmail(second, inserts[1][2] as string)).toBe("unknown@example.invalid");
    expect(JSON.stringify(tx.$executeRaw.mock.calls)).not.toContain(email);
    expect(statements().join("\n")).not.toMatch(/FROM (?:public\.)?users/iu);
  });

  it("serializa a quota e recusa o limite antes de inserir novo pedido", async () => {
    const { tx, statements } = fixture(); tx.$queryRaw.mockResolvedValue([{ count: 256 }]);
    await expect(enqueuePasswordReset(email)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(statements()[0]).toContain("pg_advisory_xact_lock");
    expect(statements().some((sql) => sql.includes("INSERT INTO"))).toBe(false);
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it("faz manutenção limitada, retirando a cifra de expirados e podando somente terminais antigos", async () => {
    const { tx } = fixture(); tx.$queryRaw.mockResolvedValue([{ count: 0 }]); await enqueuePasswordReset(email);
    const calls = tx.$executeRaw.mock.calls as unknown as RawCall[];
    const expire = calls.find((call) => sqlText(call).includes("WITH expired"))!;
    const prune = calls.find((call) => sqlText(call).includes("DELETE FROM"))!;
    expect(sqlText(expire)).toContain("payload=NULL"); expect(sqlText(expire)).toContain("FOR UPDATE SKIP LOCKED");
    expect(expire).toContain(64); expect(prune).toContain(64);
    expect(sqlText(prune)).toContain("status IN ('COMPLETED','FAILED')"); expect(sqlText(prune)).toContain("interval '1 day'");
  });

  it("processa só o pedido adquirido e apaga o payload após concluir", async () => {
    const { tx, database } = fixture(); tx.$queryRaw.mockResolvedValueOnce([job()]);
    expect(await processPasswordResetJobs({ limit: 1, jobId: id })).toEqual({ processed: 1, failed: 0 });
    expect(requestPasswordReset).toHaveBeenCalledExactlyOnceWith(email);
    const call = (database.$executeRaw.mock.calls as unknown as RawCall[]).find((entry) => sqlText(entry).includes("SET status=?"))!;
    expect(sqlText(call)).toContain("payload=NULL"); expect(sqlText(call)).toContain("locked_by=?::uuid");
    expect(call).toContain("COMPLETED"); expect(call).toContain(id); expect(call).toContain(lockId);
    const selection = tx.$queryRaw.mock.calls[0] as unknown as RawCall;
    expect(sqlText(selection)).toContain("FOR UPDATE SKIP LOCKED"); expect(sqlText(selection)).toContain("lease_until<=clock_timestamp()");
    expect(selection).toContain(3);
  });

  it("marca envelope adulterado como falha terminal sem consultar conta ou tentar enviá-lo", async () => {
    const { tx, database } = fixture(); tx.$queryRaw.mockResolvedValueOnce([job(1, "corrupted-envelope")]);
    expect(await processPasswordResetJobs({ limit: 1 })).toEqual({ processed: 0, failed: 1 });
    expect(requestPasswordReset).not.toHaveBeenCalled();
    expect((database.$executeRaw.mock.calls as unknown as RawCall[]).some((call) => call.includes("FAILED") && sqlText(call).includes("payload=NULL"))).toBe(true);
  });

  it("retenta falha de entrega com backoff e teto de tentativas, sem criar outro pedido", async () => {
    const { tx, database, statements } = fixture(); tx.$queryRaw.mockResolvedValueOnce([job(2)]);
    vi.mocked(requestPasswordReset).mockRejectedValueOnce(new Error("private SMTP diagnostic"));
    expect(await processPasswordResetJobs({ limit: 1 })).toEqual({ processed: 0, failed: 1 });
    const retry = (database.$executeRaw.mock.calls as unknown as RawCall[]).find((call) => sqlText(call).includes("status=CASE"))!;
    expect(retry).toContain(3); expect(retry).toContain(60); expect(retry).toContain(id); expect(retry).toContain(lockId);
    expect(sqlText(retry)).toContain("THEN 'FAILED' ELSE 'PENDING'");
    expect(statements().some((sql) => sql.includes("INSERT INTO"))).toBe(false);
    expect(JSON.stringify(database.$executeRaw.mock.calls)).not.toContain("private SMTP diagnostic");
  });

  it("não anuncia conclusão se outra lease já tomou posse do pedido", async () => {
    const { tx, database } = fixture(); tx.$queryRaw.mockResolvedValueOnce([job()]);
    database.$executeRaw.mockImplementation(async (parts: TemplateStringsArray) => parts.join("?").includes("SET status=?") ? 0 : 1);
    expect(await processPasswordResetJobs({ limit: 1 })).toEqual({ processed: 0, failed: 1 });
  });

  it("encerra quando não há pedido disponível, sem fazer entrega", async () => {
    fixture(); expect(await processPasswordResetJobs()).toEqual({ processed: 0, failed: 0 });
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it.each([0, -1, 26, 1.5, NaN])("recusa limite inválido %s sem consultar dados", async (limit) => {
    const { database } = fixture(); await expect(processPasswordResetJobs({ limit })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(database.$transaction).not.toHaveBeenCalled();
  });
});

describe("resposta pública independente da entrega", () => {
  it("responde antes de executar SMTP e mantém o pedido durável para after", async () => {
    const { tx } = fixture(); tx.$queryRaw.mockResolvedValueOnce([{ count: 0 }]);
    const response = await POST(new Request("http://127.0.0.1:3000/api/access/password-reset/request", { method: "POST" }));
    expect(response.status).toBe(202); expect(requestPasswordReset).not.toHaveBeenCalled(); expect(state.callbacks).toHaveLength(1);
    expect(JSON.stringify(await response.json())).not.toContain(email);
    tx.$queryRaw.mockResolvedValueOnce([job()]);
    let release!: () => void; vi.mocked(requestPasswordReset).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const work = state.callbacks[0]();
    await vi.waitFor(() => expect(requestPasswordReset).toHaveBeenCalledExactlyOnceWith(email));
    expect(response.status).toBe(202); release(); await work;
  });

  it("retorna a mesma resposta sem criar pedido quando o limite por endereço já foi atingido", async () => {
    const { database } = fixture(); vi.mocked(consumeRateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 60 });
    const response = await POST(new Request("http://127.0.0.1:3000/api/access/password-reset/request", { method: "POST" }));
    expect(response.status).toBe(202); expect(database.$transaction).not.toHaveBeenCalled(); expect(state.callbacks).toHaveLength(0);
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });
});
