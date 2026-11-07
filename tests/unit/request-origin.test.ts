import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestOrigin } from "../../src/server/security/request-origin.ts";

beforeEach(() => {
  vi.stubEnv("VERCEL", ""); vi.stubEnv("REQUEST_IP_HEADER", ""); vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("AUTH_URL", "http://127.0.0.1:3000"); vi.stubEnv("AUTH_SECRET", "segredo-exclusivo-para-origem-unitaria-0001"); vi.stubEnv("MAIL_TRANSPORT", "local");
});
afterEach(() => vi.unstubAllEnvs());
const request = (headers: HeadersInit = {}) => new Request("http://127.0.0.1/test", { headers });

describe("identidade de origem usada pelo rate limit", () => {
  it("mantém fallback somente no desenvolvimento/teste loopback e ignora XFF não configurado", () => {
    expect(requestOrigin(request({ "x-forwarded-for": "203.0.113.7" }))).toBe("local-development");
    vi.stubEnv("APP_ENV", "test"); expect(requestOrigin(request())).toBe("local-development");
  });
  it("recusa URL pública sem política em vez de compartilhar todos os clientes", () => {
    vi.stubEnv("AUTH_URL", "https://public.example.invalid"); vi.stubEnv("APP_ENV", "demo"); vi.stubEnv("MAIL_TRANSPORT", "smtp");
    expect(() => requestOrigin(request({ "x-forwarded-for": "203.0.113.7" }))).toThrow(expect.objectContaining({ code: "UNAVAILABLE" }));
  });
  it("exige IP válido do cabeçalho da Vercel e ignora cabeçalhos alternativos", () => {
    vi.stubEnv("VERCEL", "1"); vi.stubEnv("REQUEST_IP_HEADER", "x-real-ip");
    expect(requestOrigin(request({ "x-vercel-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.4" }))).toBe("203.0.113.7");
    expect(() => requestOrigin(request({ "x-real-ip": "198.51.100.4" }))).toThrow(expect.objectContaining({ code: "UNAVAILABLE" }));
  });
  it("separa clientes em um ingresso explicitamente configurado e normaliza IPv6", () => {
    vi.stubEnv("REQUEST_IP_HEADER", "x-real-ip");
    expect(requestOrigin(request({ "x-real-ip": "203.0.113.7" }))).not.toBe(requestOrigin(request({ "x-real-ip": "198.51.100.4" })));
    expect(requestOrigin(request({ "x-real-ip": "2001:0DB8:0000:0000:0000:0000:0000:0001" }))).toBe("2001:db8::1");
  });
  it.each([undefined, "unknown", "203.0.113.7, 198.51.100.4", "203.0.113.7:443", "203.000.113.007"])("recusa cabeçalho ausente, lista ou formato inválido: %s", (value) => {
    vi.stubEnv("REQUEST_IP_HEADER", "x-real-ip");
    expect(() => requestOrigin(request(value ? { "x-real-ip": value } : {}))).toThrow(expect.objectContaining({ code: "UNAVAILABLE" }));
  });
  it("recusa nome de cabeçalho de ingresso malformado", () => {
    vi.stubEnv("REQUEST_IP_HEADER", "x-real-ip, x-forwarded-for");
    expect(() => requestOrigin(request())).toThrow(expect.objectContaining({ code: "UNAVAILABLE" }));
  });
});
