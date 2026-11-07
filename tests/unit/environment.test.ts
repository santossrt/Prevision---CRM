import { describe, expect, it } from "vitest";
import { assertDatabaseIdentity, assertLocalDevelopmentDatabase, readEnvironment } from "../../src/server/config/environment";

const local = {
  APP_ENV: "development",
  DATABASE_ID: "prevision-local-development",
  DATABASE_URL: "postgresql://app:local-secret@127.0.0.1:54329/prevision_dev",
  DIRECT_URL: "postgresql://admin:other-secret@127.0.0.1:54329/prevision_dev"
};

describe("isolamento da configuração do banco", () => {
  it("aceita configuração local válida", () => {
    expect(readEnvironment(local).APP_ENV).toBe("development");
    expect(() => assertLocalDevelopmentDatabase(readEnvironment(local))).not.toThrow();
  });

  it("recusa URL inválida sem revelar o valor fornecido", () => {
    expect(() => readEnvironment({ ...local, DATABASE_URL: "https://app:do-not-leak@example.test/db" }))
      .toThrow("Configuração de ambiente inválida: DATABASE_URL");
    try { readEnvironment({ ...local, DATABASE_URL: "do-not-leak" }); }
    catch (error) { expect(String(error)).not.toContain("do-not-leak"); }
  });

  it("recusa demonstração usando identidade local", () => {
    expect(() => readEnvironment({ ...local, APP_ENV: "demo" })).toThrow("identificação de banco independente");
  });

  it.each([
    { ...local, APP_ENV: "test" },
    { ...local, DIRECT_URL: "postgresql://admin:secret@remote.example/prevision_dev" },
    { ...local, DIRECT_URL: "postgresql://admin:secret@localhost/another_database" },
    { ...local, DATABASE_URL: "postgresql://app:secret@remote.example/prevision_dev" },
    { ...local, DATABASE_URL: "postgresql://app:secret@localhost:54330/prevision_dev" },
    { ...local, DATABASE_ID: "another-database" }
  ])("impede identificação administrativa fora do banco local esperado", (source) => {
    expect(() => assertLocalDevelopmentDatabase(readEnvironment(source))).toThrow();
  });

  it("interrompe acesso a banco sem sentinela ou com identidade divergente", () => {
    const environment = readEnvironment(local);
    expect(() => assertDatabaseIdentity(environment, null)).toThrow();
    expect(() => assertDatabaseIdentity(environment, { environment: "demo", databaseId: environment.DATABASE_ID })).toThrow();
    expect(() => assertDatabaseIdentity(environment, { environment: "development", databaseId: "other" })).toThrow();
    expect(() => assertDatabaseIdentity(environment, { environment: environment.APP_ENV, databaseId: environment.DATABASE_ID })).not.toThrow();
  });
});
