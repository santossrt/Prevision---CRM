import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApplicationError, type ApplicationErrorCode } from "../../src/server/errors/application-error.ts";
import { getAuthCapabilities, getAuthSettings, sessionCookieName } from "../../src/server/auth/settings.ts";
import { createCsrfToken } from "../../src/server/security/csrf.ts";
import { assertCsrf, assertSameOrigin, assertTrustedHost, errorResponse, limitRequest, readJson } from "../../src/server/security/http.ts";
import { consumeRateLimit } from "../../src/server/security/rate-limit.ts";

vi.mock("../../src/server/security/rate-limit.ts", () => ({ consumeRateLimit: vi.fn() }));

const secret = "segredo-exclusivo-para-testes-unitarios-0001";
const now = Date.UTC(2026, 9, 30, 12);

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", secret);
  vi.stubEnv("AUTH_URL", "http://127.0.0.1:3000");
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("MAIL_TRANSPORT", "local");
  vi.stubEnv("GOOGLE_CLIENT_ID", "");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
  vi.stubEnv("VERCEL", "");
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.mocked(consumeRateLimit).mockReset().mockResolvedValue({ allowed: true, retryAfter: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function request({ session = "sessao-a", body = "{}", headers: overrides = {} }: { session?: string; body?: string; headers?: Record<string, string | null> } = {}) {
  const settings = getAuthSettings();
  const token = createCsrfToken(session, secret, now);
  const headers = new Headers({
    host: settings.url.host,
    origin: settings.url.origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "X-Prevision-CSRF": token,
    cookie: `${session ? `${sessionCookieName()}=${session}; ` : ""}prevision.csrf=${token}`,
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Request(new URL("/api/teste", settings.url), { method: "POST", headers, body });
}

function expectForbidden(operation: () => void) {
  expect(operation).toThrowError(expect.objectContaining({ name: "ApplicationError", code: "FORBIDDEN" }));
}

describe("origem e host das requisições", () => {
  it("aceita o host configurado e sua representação sem diferença de caixa", () => {
    expect(() => assertTrustedHost(request())).not.toThrow();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    expect(() => assertTrustedHost(request({ headers: { host: "LOCALHOST:3000" } }))).not.toThrow();
  });

  it.each([null, "atacante.invalid", "127.0.0.1:4000", "127.0.0.1:3000.atacante.invalid"])("rejeita Host ausente ou adulterado: %s", (host) => {
    expectForbidden(() => assertTrustedHost(request({ headers: { host, "x-forwarded-host": "127.0.0.1:3000" } })));
  });

  it.each([null, "null", "https://127.0.0.1:3000", "http://127.0.0.1:4000", "http://atacante.invalid", "http://127.0.0.1:3000.atacante.invalid"])("exige Origin idêntico ao configurado: %s", (origin) => {
    expectForbidden(() => assertSameOrigin(request({ headers: { origin } })));
  });

  it("rejeita fetch cross-site mesmo quando Origin afirma ser local", () => {
    expectForbidden(() => assertSameOrigin(request({ headers: { "sec-fetch-site": "cross-site" } })));
  });

  it("mantém a validação de Origin mesmo sem o cabeçalho opcional Fetch Metadata", () => {
    expect(() => assertSameOrigin(request({ headers: { "sec-fetch-site": null } }))).not.toThrow();
    expectForbidden(() => assertSameOrigin(request({ headers: { "sec-fetch-site": null, origin: "http://atacante.invalid" } })));
  });
});

describe("double-submit CSRF vinculado à sessão", () => {
  it("aceita somente a mesma prova assinada no cookie e no cabeçalho", () => {
    expect(() => assertCsrf(request())).not.toThrow();
    const another = createCsrfToken("sessao-a", secret, now);
    expectForbidden(() => assertCsrf(request({ headers: { "X-Prevision-CSRF": another } })));
    expectForbidden(() => assertCsrf(request({ headers: { "X-Prevision-CSRF": null } })));
    expectForbidden(() => assertCsrf(request({ headers: { cookie: "prevision.session-token=sessao-a" } })));
  });

  it("não aceita assinatura falsificada mesmo quando cookie e cabeçalho coincidem", () => {
    const token = createCsrfToken("sessao-a", secret, now);
    const forged = token.slice(0, -1) + (token.endsWith("a") ? "b" : "a");
    expectForbidden(() => assertCsrf(request({ headers: { cookie: `prevision.session-token=sessao-a; prevision.csrf=${forged}`, "X-Prevision-CSRF": forged } })));
  });

  it("rejeita token copiado entre sessões autenticadas", () => {
    const token = createCsrfToken("sessao-a", secret, now);
    expectForbidden(() => assertCsrf(request({ headers: { cookie: `prevision.session-token=sessao-b; prevision.csrf=${token}`, "X-Prevision-CSRF": token } })));
  });

  it("aceita o fluxo anônimo e exige renovação do token após login", () => {
    expect(() => assertCsrf(request({ session: "" }))).not.toThrow();
    const token = createCsrfToken("", secret, now);
    expectForbidden(() => assertCsrf(request({ headers: { cookie: `prevision.session-token=sessao-a; prevision.csrf=${token}`, "X-Prevision-CSRF": token } })));
  });

  it("reconstitui a sessão a partir dos chunks antes de conferir a assinatura", () => {
    const token = createCsrfToken("primeirasegunda", secret, now);
    const cookie = `prevision.session-token.1=segunda; prevision.csrf=${token}; prevision.session-token.0=primeira`;
    expect(() => assertCsrf(request({ headers: { cookie, "X-Prevision-CSRF": token } }))).not.toThrow();
  });

  it("não aceita um token já expirado nas APIs protegidas", () => {
    const token = createCsrfToken("sessao-a", secret, now - 7_200_000);
    expectForbidden(() => assertCsrf(request({ headers: { cookie: `prevision.session-token=sessao-a; prevision.csrf=${token}`, "X-Prevision-CSRF": token } })));
  });
});

describe("leitura de corpos JSON", () => {
  it("aceita JSON válido com charset explícito", async () => {
    await expect(readJson(request({ body: JSON.stringify({ name: "João", enabled: true }), headers: { "content-type": "application/json; charset=utf-8" } }))).resolves.toEqual({ name: "João", enabled: true });
  });

  it.each([null, "text/plain", "application/x-www-form-urlencoded", "application/jsonp"])("recusa tipos de conteúdo incompatíveis: %s", async (contentType) => {
    await expect(readJson(request({ headers: { "content-type": contentType } }))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("recusa JSON inválido sem retornar o conteúdo recebido", async () => {
    await expect(readJson(request({ body: '{"password":"segredo-que-nao-deve-aparecer"' }))).rejects.toMatchObject({ code: "VALIDATION", message: "Dados inválidos." });
  });

  it("bloqueia Content-Length excessivo antes de ler o corpo", async () => {
    const oversized = request({ headers: { "content-length": "16385" } });
    const read = vi.spyOn(oversized, "text");
    await expect(readJson(oversized)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(read).not.toHaveBeenCalled();
  });

  it("mede bytes UTF-8 mesmo sem Content-Length", async () => {
    const body = JSON.stringify({ value: "á".repeat(8192) });
    expect(body.length).toBeLessThan(16384);
    expect(Buffer.byteLength(body)).toBeGreaterThan(16384);
    await expect(readJson(request({ body }))).rejects.toMatchObject({ code: "VALIDATION", message: "Solicitação muito grande." });
  });

  it("aceita o limite exato de 16 KiB e recusa o byte seguinte", async () => {
    const body = JSON.stringify("a".repeat(16382));
    expect(Buffer.byteLength(body)).toBe(16384);
    await expect(readJson(request({ body }))).resolves.toHaveLength(16382);
    await expect(readJson(request({ body: JSON.stringify("a".repeat(16383)) }))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  function unicodeInventoryBatch() {
    return {
      expectedVersion: 2,
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      items: Array.from({ length: 20 }, (_, index) => ({
        productId: `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`,
        countedQuantity: "0.0000",
        justification: "á".repeat(600)
      }))
    };
  }

  it("aceita lote de inventário com vinte justificativas Unicode de 600 caracteres no limite explícito de 64 KiB", async () => {
    const batch = unicodeInventoryBatch();
    const body = JSON.stringify(batch);
    expect(Buffer.byteLength(body)).toBeGreaterThan(16384);
    expect(Buffer.byteLength(body)).toBeLessThan(65536);
    expect(batch.items.every((item) => item.justification.length === 600)).toBe(true);
    await expect(readJson(request({ body }), 65536)).resolves.toEqual(batch);
  });

  it("mantém o mesmo lote Unicode bloqueado no limite padrão de 16 KiB", async () => {
    const body = JSON.stringify(unicodeInventoryBatch());
    await expect(readJson(request({ body }))).rejects.toMatchObject({ code: "VALIDATION", message: "Solicitação muito grande." });
  });

  it("bloqueia Content-Length de 65537 bytes antes de ler no limite explícito de 64 KiB", async () => {
    const oversized = request({ headers: { "content-length": "65537" } });
    const read = vi.spyOn(oversized, "text");
    await expect(readJson(oversized, 65536)).rejects.toMatchObject({ code: "VALIDATION", message: "Solicitação muito grande." });
    expect(read).not.toHaveBeenCalled();
  });

  it("mede 65537 bytes UTF-8 reais mesmo com Content-Length menor", async () => {
    const body = JSON.stringify("漢".repeat(21845));
    expect(body.length).toBeLessThan(65536);
    expect(Buffer.byteLength(body)).toBe(65537);
    await expect(readJson(request({ body, headers: { "content-length": "2" } }), 65536))
      .rejects.toMatchObject({ code: "VALIDATION", message: "Solicitação muito grande." });
  });

  it("aceita exatamente 65536 bytes UTF-8 no limite explícito de 64 KiB", async () => {
    const value = "漢".repeat(21844) + "aa";
    const body = JSON.stringify(value);
    expect(Buffer.byteLength(body)).toBe(65536);
    await expect(readJson(request({ body }), 65536)).resolves.toBe(value);
  });

  it("exige CSRF válido antes de interpretar qualquer corpo", async () => {
    const untrusted = request({ body: "inválido", headers: { "X-Prevision-CSRF": null } });
    const read = vi.spyOn(untrusted, "text");
    await expect(readJson(untrusted)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(read).not.toHaveBeenCalled();
  });
});

describe("respostas de erro e limites de requisição", () => {
  it("oculta mensagens internas, stack, senha e credenciais, inclusive no log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sensitive = new Error("password=senha-super-secreta; AUTH_SECRET=segredo-interno; postgres://usuario:senha@host/db");
    const response = errorResponse(sensitive);
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body).toEqual({ message: "Não foi possível concluir a operação. Tente novamente." });
    const emitted = JSON.stringify([body, log.mock.calls]);
    for (const value of ["senha-super-secreta", "segredo-interno", "postgres://", sensitive.stack]) expect(emitted).not.toContain(value);
  });

  it("converte erros Zod em resposta genérica sem expor detalhes dos campos", async () => {
    const schema = z.string().superRefine((_value, context) => { context.addIssue({ code: "custom", message: "password=senha-privada" }); });
    const invalid = schema.safeParse("entrada");
    if (invalid.success) throw new Error("O cenário deve produzir erro de validação.");
    const response = errorResponse(invalid.error);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Confira os campos informados." });
  });

  it.each<[ApplicationErrorCode, number]>([["VALIDATION", 400], ["UNAUTHORIZED", 401], ["FORBIDDEN", 403], ["NOT_FOUND", 404], ["CONFLICT", 409], ["RATE_LIMIT", 429], ["UNAVAILABLE", 503]])("mapeia %s para HTTP %i sem serializar stack ou código interno", async (code, status) => {
    const response = errorResponse(new ApplicationError(code, "Mensagem pública."));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ message: "Mensagem pública." });
    if (code === "RATE_LIMIT") expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("transforma limite compartilhado excedido em HTTP 429 sem consultar banco real", async () => {
    vi.mocked(consumeRateLimit).mockResolvedValue({ allowed: false, retryAfter: 25 });
    const failure = await limitRequest(request(), "recuperacao", 3, 60, "conta@example.invalid").catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "RATE_LIMIT" });
    expect(consumeRateLimit).toHaveBeenCalledWith(["recuperacao", "local-development", "conta@example.invalid"], 3, 60);
    expect(errorResponse(failure).status).toBe(429);
  });

  it("permite a requisição quando o armazenamento compartilhado aprova", async () => {
    await expect(limitRequest(request(), "cadastro")).resolves.toBeUndefined();
    expect(consumeRateLimit).toHaveBeenCalledWith(["cadastro", "local-development"], 60, 900);
  });
});

describe("configuração pública e cookies de autenticação", () => {
  it("exige segredo com ao menos 32 caracteres", () => {
    vi.stubEnv("AUTH_SECRET", "curto");
    expect(() => getAuthSettings()).toThrow();
  });

  it("usa cookie Secure em HTTPS e não permite transporte local no ambiente de demonstração", () => {
    vi.stubEnv("AUTH_URL", "https://demo.example.invalid");
    expect(getAuthSettings().secure).toBe(true);
    expect(sessionCookieName()).toBe("__Secure-prevision.session-token");
    vi.stubEnv("APP_ENV", "demonstration");
    expect(() => getAuthSettings()).toThrow();
    vi.stubEnv("MAIL_TRANSPORT", "smtp");
    expect(getAuthSettings().transport).toBe("smtp");
  });

  it.each(["http://atacante.invalid", "ftp://127.0.0.1:3000", "ws://localhost:3000", "https://usuario:senha@demo.example.invalid", "https://demo.example.invalid/caminho", "https://demo.example.invalid?token=segredo", "https://demo.example.invalid#fragmento"])("rejeita AUTH_URL fora da política: %s", (url) => {
    vi.stubEnv("AUTH_URL", url);
    expect(() => getAuthSettings()).toThrow();
  });

  it("habilita Google somente com ambas as credenciais, sem incluí-las no resultado", () => {
    expect(getAuthCapabilities()).toEqual({ google: false, emailDelivery: "local" });
    vi.stubEnv("GOOGLE_CLIENT_ID", "client-id-privado");
    expect(getAuthCapabilities().google).toBe(false);
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret-privado");
    expect(getAuthCapabilities()).toEqual({ google: true, emailDelivery: "local" });
  });
});
