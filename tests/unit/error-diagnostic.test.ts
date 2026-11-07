import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApplicationError, type ApplicationErrorCode } from "../../src/server/errors/application-error.ts";
import { errorDiagnostic } from "../../src/server/security/error-diagnostic.ts";
import { errorResponse } from "../../src/server/security/http.ts";

vi.mock("../../src/server/security/rate-limit.ts", () => ({ consumeRateLimit: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe("diagnóstico seguro de erros inesperados", () => {
  it.each([
    "PrismaClientKnownRequestError", "PrismaClientUnknownRequestError",
    "PrismaClientInitializationError", "PrismaClientValidationError", "PrismaClientRustPanicError",
    "DriverAdapterError", "DatabaseError", "ConnectionError"
  ])("permite a categoria fixa %s", (name) => {
    expect(errorDiagnostic({ name, message: "credencial privada", stack: "stack privado" })).toEqual({ name });
  });

  it.each(["P2002", "P1001", "P2028", "23505", "42P01", "08006"])("permite somente o código restrito %s", (code) => {
    expect(errorDiagnostic({ name: "PrismaClientKnownRequestError", code })).toEqual({ name: "PrismaClientKnownRequestError", code });
  });

  it("reconhece errorCode usado na inicialização do Prisma", () => {
    expect(errorDiagnostic({ name: "PrismaClientInitializationError", errorCode: "P1001" }))
      .toEqual({ name: "PrismaClientInitializationError", code: "P1001" });
  });

  it("classifica SQLSTATE e falhas de conexão sem registrar mensagens ou códigos livres", () => {
    expect(errorDiagnostic({ name: "error", code: "23505" })).toEqual({ name: "DatabaseError", code: "23505" });
    expect(errorDiagnostic(Object.assign(new Error("host e senha privados"), { code: "ECONNREFUSED" })))
      .toEqual({ name: "ConnectionError" });
  });

  it.each(["P2002\nsegredo", "P2002\n", "P12345", "p2002", "23505; password=privado", "ABCDE", "00000", "segredo"])("omite código não permitido: %s", (code) => {
    expect(errorDiagnostic({ name: "nome privado", code })).toEqual({ name: "UnexpectedError" });
  });

  it("não serializa erro, mensagem, stack, metadados, query, causa ou credenciais", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = Object.assign(new Error("password=senha-privada"), {
      name: "PrismaClientKnownRequestError", code: "P2002", stack: "stack-privado",
      meta: { secret: "meta-privado" }, query: "query-privada", cause: new Error("causa-privada"),
      toJSON: vi.fn(() => ({ token: "token-privado" }))
    });
    const response = errorResponse(error);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "[prevision] Operação não concluída; detalhes sensíveis foram omitidos.",
      { name: "PrismaClientKnownRequestError", code: "P2002" }
    );
    expect(error.toJSON).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ message: "Não foi possível concluir a operação. Tente novamente." });
    const emitted = JSON.stringify([log.mock.calls, body]);
    for (const secret of ["senha-privada", "stack-privado", "meta-privado", "query-privada", "causa-privada", "token-privado"]) {
      expect(emitted).not.toContain(secret);
    }
  });

  it("não executa getters ao classificar o diagnóstico", () => {
    const getter = vi.fn(() => { throw new Error("segredo no getter"); });
    const error = Object.create(null, { name: { get: getter }, code: { get: getter }, errorCode: { get: getter } });
    expect(errorDiagnostic(error)).toEqual({ name: "UnexpectedError" });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "password=privado", 42, Symbol("privado")])("aceita valores lançados sem estrutura de Error", (error) => {
    expect(errorDiagnostic(error)).toEqual({ name: "UnexpectedError" });
  });

  it.each<[ApplicationErrorCode, number]>([
    ["VALIDATION", 400], ["UNAUTHORIZED", 401], ["FORBIDDEN", 403], ["NOT_FOUND", 404],
    ["CONFLICT", 409], ["RATE_LIMIT", 429], ["UNAVAILABLE", 503]
  ])("preserva resposta pública e status de %s", async (code, status) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = errorResponse(new ApplicationError(code, "Mensagem pública."));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ message: "Mensagem pública." });
    expect(log).not.toHaveBeenCalled();
    if (code === "RATE_LIMIT") expect(response.headers.get("Retry-After")).toBe("900");
  });

  it("preserva resposta de validação Zod sem registrar detalhes privados", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const parsed = z.string().min(10, "password=privado").safeParse("curto");
    if (parsed.success) throw new Error("O teste precisa de um erro Zod.");
    const response = errorResponse(parsed.error);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Confira os campos informados." });
    expect(log).not.toHaveBeenCalled();
  });
});
