import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST, GET } from "../../src/app/api/auth/[...nextauth]/route.ts";
import { handlers } from "../../src/server/auth/config.ts";
import { getToken } from "next-auth/jwt";
import { revokeLoginSession } from "../../src/server/auth/sessions.ts";
import { limitRequest } from "../../src/server/security/http.ts";
import { ApplicationError } from "../../src/server/errors/application-error.ts";

vi.mock("../../src/server/auth/config.ts", () => ({ handlers: { GET: vi.fn(), POST: vi.fn() } }));
vi.mock("next-auth/jwt", () => ({ getToken: vi.fn() }));
vi.mock("../../src/server/auth/sessions.ts", () => ({ revokeLoginSession: vi.fn() }));
vi.mock("../../src/server/security/http.ts", async (original) => ({ ...await original<typeof import("../../src/server/security/http.ts")>(), limitRequest: vi.fn() }));

const origin = "http://127.0.0.1:3000";
beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "segredo-exclusivo-para-route-auth-test-0001"); vi.stubEnv("AUTH_URL", origin);
  vi.stubEnv("APP_ENV", "test"); vi.stubEnv("MAIL_TRANSPORT", "local");
  vi.mocked(limitRequest).mockReset().mockResolvedValue(undefined);
  vi.mocked(handlers.POST).mockReset().mockResolvedValue(Response.json({ accepted: true }));
  vi.mocked(handlers.GET).mockReset().mockResolvedValue(Response.json({ accepted: true }));
  vi.mocked(getToken).mockReset().mockResolvedValue(null);
  vi.mocked(revokeLoginSession).mockReset().mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
function request(body: BodyInit, path = "/api/auth/callback/credentials", extra: HeadersInit = {}) {
  const headers = new Headers({ host: "127.0.0.1:3000", origin, "content-type": "application/x-www-form-urlencoded", cookie: "prevision.session-token=fake-session; prevision.csrf=fake-csrf", "X-Auth-Return-Redirect": "1" });
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new NextRequest(origin + path, { method: "POST", headers, body, credentials: "include", redirect: "manual" });
}

describe("leitura limitada da rota Auth.js", () => {
  it("reconstitui NextRequest com os mesmos bytes, URL, cookies e cabeçalhos do login", async () => {
    const form = new URLSearchParams({ email: "synthetic@example.invalid", password: "á+& test / password", csrfToken: "fake-auth-csrf", callbackUrl: origin + "/perfil" }).toString();
    const input = request(form, "/api/auth/callback/credentials?source=unit", { "content-length": "2" });
    const cloning = vi.spyOn(input, "clone"); const wholeText = vi.spyOn(input, "text");
    vi.mocked(handlers.POST).mockImplementation(async (bounded) => {
      expect(bounded).toBeInstanceOf(NextRequest); expect(bounded).not.toBe(input);
      expect(bounded.url).toBe(input.url); expect(bounded.nextUrl.pathname).toBe("/api/auth/callback/credentials");
      expect(bounded.credentials).toBe("include"); expect(bounded.redirect).toBe("manual");
      expect(bounded.cookies.get("prevision.session-token")?.value).toBe("fake-session");
      expect(bounded.headers.get("x-auth-return-redirect")).toBe("1");
      expect(bounded.headers.get("content-length")).toBe(String(Buffer.byteLength(form)));
      expect(await bounded.text()).toBe(form); return Response.json({ accepted: true });
    });
    expect((await POST(input)).status).toBe(200); expect(cloning).not.toHaveBeenCalled(); expect(wholeText).not.toHaveBeenCalled();
    expect(limitRequest).toHaveBeenCalledWith(input, "auth-write", 120, 900);
  });

  it("limita a taxa antes de consumir qualquer chunk e cancela o corpo recusado", async () => {
    let read = false; let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { read = true; controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    vi.mocked(limitRequest).mockRejectedValue(new ApplicationError("RATE_LIMIT", "Muitas tentativas."));
    expect((await POST(request(stream))).status).toBe(429);
    expect(read).toBe(false); expect(cancelled).toBe(true); expect(handlers.POST).not.toHaveBeenCalled();
  });

  it("recusa corpo excessivo com413 e não encaminha conteúdo parcial ao Auth.js", async () => {
    let chunks = 0; let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { chunks++; controller.enqueue(new Uint8Array(4096)); if (chunks === 64) controller.close(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    const response = await POST(request(stream));
    expect(response.status).toBe(413); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cancelled).toBe(true); expect(chunks).toBeLessThan(64); expect(handlers.POST).not.toHaveBeenCalled();
  });

  it("interrompe o corpo parado em10s e não chama o handler", async () => {
    vi.useFakeTimers(); let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => {}); } });
    const pending = POST(request(stream));
    await vi.advanceTimersByTimeAsync(10000);
    expect((await pending).status).toBe(408); expect(cancelled).toBe(true); expect(handlers.POST).not.toHaveBeenCalled();
  });

  it("preserva a prova de sessão no logout e revoga antes de encaminhar", async () => {
    vi.mocked(getToken).mockResolvedValue({ sid: "fake-sid", sub: "fake-user" });
    const input = request("csrfToken=fake-token", "/api/auth/signout");
    expect((await POST(input)).status).toBe(200);
    expect(getToken).toHaveBeenCalledWith(expect.objectContaining({ req: expect.any(NextRequest), cookieName: "prevision.session-token" }));
    expect(revokeLoginSession).toHaveBeenCalledWith("fake-sid", "fake-user");
    expect(vi.mocked(revokeLoginSession).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(handlers.POST).mock.invocationCallOrder[0]);
  });

  it("mantém o GET de OAuth/CSRF intacto após a conferência da origem e taxa", async () => {
    const input = new NextRequest(origin + "/api/auth/callback/google?code=synthetic&state=synthetic", { headers: { host: "127.0.0.1:3000" } });
    expect((await GET(input)).status).toBe(200);
    expect(handlers.GET).toHaveBeenCalledWith(input); expect(limitRequest).toHaveBeenCalledWith(input, "auth-read", 240, 60);
  });
});
