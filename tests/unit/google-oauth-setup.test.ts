import { describe, expect, it } from "vitest";
import { parse } from "dotenv";
import { prepareGoogleEnvironment } from "../../scripts/setup-google-oauth.ts";

const clientId = "1234567890-testclient.apps.googleusercontent.com";
const clientSecret = "GOCSPX-synthetic_secret_for_test_123";
const origin = "http://127.0.0.1:3000";
const json = (overrides: Record<string, unknown> = {}) => JSON.stringify({ web: {
  client_id: clientId, client_secret: clientSecret,
  redirect_uris: [`${origin}/api/auth/callback/google`], ...overrides
} });
const environment = `# Configuração privada preservada\r\nAPP_ENV=development\r\nAUTH_URL=${origin}\r\nAUTH_SECRET=keep-exactly-this\r\nDATABASE_URL='keep-this-too'\r\nMULTILINE="first\r\nGOOGLE_CLIENT_ID=not-an-assignment\r\nlast"`;

describe("importação local de credenciais Google", () => {
  it("preserva literalmente a configuração anterior e importa somente ID e segredo", () => {
    const result = prepareGoogleEnvironment(environment, json());
    expect(result.startsWith(environment + "\r\n")).toBe(true);
    expect(parse(result)).toMatchObject({ APP_ENV: "development", AUTH_URL: origin, AUTH_SECRET: "keep-exactly-this", DATABASE_URL: "keep-this-too", GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret });
    expect(result).not.toContain("redirect_uris");
    expect(result).not.toContain("client_id");
  });

  it("é idempotente e pode preencher somente o campo que está vazio", () => {
    const first = prepareGoogleEnvironment(environment + `\r\nGOOGLE_CLIENT_ID=${clientId}\r\nGOOGLE_CLIENT_SECRET=\r\n`, json());
    expect(prepareGoogleEnvironment(first, json())).toBe(first);
    expect(first.match(new RegExp(`GOOGLE_CLIENT_ID=${clientId.replaceAll(".", "\\.")}`, "g"))).toHaveLength(1);
    expect(parse(first).GOOGLE_CLIENT_SECRET).toBe(clientSecret);
  });

  it.each(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])("recusa substituir %s preenchido com outro valor", (key) => {
    expect(() => prepareGoogleEnvironment(environment + `\n${key}=different-existing-value\n`, json())).toThrow("Já existem credenciais Google diferentes");
  });

  it("exige callback correspondente exatamente à origem configurada", () => {
    expect(() => prepareGoogleEnvironment(environment, json({ redirect_uris: ["http://localhost:3000/api/auth/callback/google"] }))).toThrow("callback exato");
    expect(() => prepareGoogleEnvironment(environment, json({ redirect_uris: [`${origin}/api/auth/callback/google/`] }))).toThrow("callback exato");
  });

  it.each(["demo", "test", "production"])("não permite importar em APP_ENV=%s", (appEnv) => {
    expect(() => prepareGoogleEnvironment(environment.replace("APP_ENV=development", `APP_ENV=${appEnv}`), json())).toThrow("desenvolvimento HTTP local");
  });

  it.each(["https://example.com", "http://192.168.0.1:3000", "http://127.0.0.1:3000/path", "http://user:private@127.0.0.1:3000"])("recusa origem não local ou com dados adicionais", (url) => {
    expect(() => prepareGoogleEnvironment(environment.replace(origin, url), json())).toThrow("desenvolvimento HTTP local");
  });

  it("recusa cliente instalado ou JSON malformado sem incluir o conteúdo no erro", () => {
    expect(() => prepareGoogleEnvironment(environment, JSON.stringify({ installed: { client_secret: clientSecret } }))).toThrow("Aplicativo da Web");
    try { prepareGoogleEnvironment(environment, `{"secret":"${clientSecret}"`); }
    catch (error) { expect(String(error)).not.toContain(clientSecret); expect(String(error)).toContain("JSON de credenciais válido"); }
  });

  it.each([`line\nINJECTED=1`, "a".repeat(16) + "$VALUE", "a".repeat(16) + "'", "a".repeat(16) + "\\"])("recusa caracteres que interferem no dotenv sem revelar o segredo", (secret) => {
    try { prepareGoogleEnvironment(environment, json({ client_secret: secret })); expect.fail("A entrada inválida deveria ser recusada."); }
    catch (error) { expect(String(error)).not.toContain(secret); expect(String(error)).toContain("ID e um segredo de cliente válidos"); }
  });
});
