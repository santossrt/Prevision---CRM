import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCsrfToken, readCookie, verifyCsrfToken } from "../../src/server/security/csrf.ts";

const secret = "segredo-exclusivo-para-testes-unitarios-0001";
const now = Date.UTC(2026, 9, 30, 12);

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", secret);
  vi.stubEnv("AUTH_URL", "http://127.0.0.1:3000");
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("MAIL_TRANSPORT", "local");
});

afterEach(() => vi.unstubAllEnvs());

describe("integridade e validade do token CSRF", () => {
  it("aceita o token somente com o segredo e a sessão usados na emissão", () => {
    const token = createCsrfToken("sessao-a", secret, now);
    expect(verifyCsrfToken(token, "sessao-a", secret, now)).toBe(true);
    expect(verifyCsrfToken(token, "sessao-b", secret, now)).toBe(false);
    expect(verifyCsrfToken(token, "sessao-a", "outro-segredo-de-testes-com-mais-de-32-caracteres", now)).toBe(false);
  });

  it("gera nonces diferentes para solicitações da mesma sessão", () => {
    const first = createCsrfToken("sessao-a", secret, now);
    const second = createCsrfToken("sessao-a", secret, now);
    expect(first).not.toBe(second);
    expect(verifyCsrfToken(first, "sessao-a", secret, now)).toBe(true);
    expect(verifyCsrfToken(second, "sessao-a", secret, now)).toBe(true);
  });

  it("detecta adulteração do nonce, da validade e da assinatura HMAC", () => {
    const [nonce, expires, signature] = createCsrfToken("sessao-a", secret, now).split(".");
    const changeHex = (value: string) => `${value[0] === "a" ? "b" : "a"}${value.slice(1)}`;
    for (const changed of [
      `${changeHex(nonce)}.${expires}.${signature}`,
      `${nonce}.${Number(expires) - 1}.${signature}`,
      `${nonce}.${expires}.${changeHex(signature)}`,
    ]) expect(verifyCsrfToken(changed, "sessao-a", secret, now)).toBe(false);
  });

  it("vence exatamente após duas horas e rejeita emissão no futuro", () => {
    const token = createCsrfToken("sessao-a", secret, now);
    expect(verifyCsrfToken(token, "sessao-a", secret, now + 7_199_000)).toBe(true);
    expect(verifyCsrfToken(token, "sessao-a", secret, now + 7_200_000)).toBe(false);
    expect(verifyCsrfToken(token, "sessao-a", secret, now + 7_201_000)).toBe(false);
    expect(verifyCsrfToken(createCsrfToken("sessao-a", secret, now + 1000), "sessao-a", secret, now)).toBe(false);
  });

  it("não reaproveita o token anônimo depois do login nem o token autenticado após logout", () => {
    const anonymous = createCsrfToken("", secret, now);
    const authenticated = createCsrfToken("sessao-a", secret, now);
    expect(verifyCsrfToken(anonymous, "", secret, now)).toBe(true);
    expect(verifyCsrfToken(anonymous, "sessao-a", secret, now)).toBe(false);
    expect(verifyCsrfToken(authenticated, "", secret, now)).toBe(false);
  });

  it("recusa formatos incompletos, extensões e entradas excessivas sem lançar erro", () => {
    const valid = createCsrfToken("sessao-a", secret, now);
    const malformed = [undefined, "", "texto", ".", "..", `${valid}.extra`, "x".repeat(201), valid.toUpperCase(), valid.replace(/\./, "-")];
    for (const value of malformed) expect(verifyCsrfToken(value, "sessao-a", secret, now)).toBe(false);
  });
});

describe("leitura dos cookies de sessão", () => {
  const name = "prevision.session-token";

  it("preserva o valor completo, incluindo sinais de igual", () => {
    expect(readCookie(`outra=abc; ${name}=parte=codificada==; final=xyz`, name)).toBe("parte=codificada==");
  });

  it("reúne chunks por índice numérico independentemente da ordem do cabeçalho", () => {
    const cookie = `${name}.10=dez; outro=ignorado; ${name}.2=dois; ${name}.0=zero; ${name}.1=um`;
    expect(readCookie(cookie, name)).toBe("zeroumdoisdez");
  });

  it("ignora cookies de prefixos parecidos e sufixos que não são índices", () => {
    const cookie = `${name}-extra=invasor; ${name}.invalid=invasor; ${name}.0=correto; ${name}extra.1=invasor`;
    expect(readCookie(cookie, name)).toBe("correto");
    expect(readCookie(cookie, "inexistente")).toBe("");
    expect(readCookie("", name)).toBe("");
  });

  it("prioriza o cookie inteiro sobre fragments antigos da mesma sessão", () => {
    const cookie = `${name}.0=antigo; ${name}=atual; ${name}.1=restante`;
    expect(readCookie(cookie, name)).toBe("atual");
  });

  it("lê também o nome seguro utilizado em HTTPS", () => {
    const secure = "__Secure-prevision.session-token";
    expect(readCookie(`${secure}.1=final; ${secure}.0=inicio`, secure)).toBe("iniciofinal");
  });
});
