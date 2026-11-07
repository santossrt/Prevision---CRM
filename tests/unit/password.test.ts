import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword, passwordSchema, verifyPassword } from "../../src/server/security/password.ts";
import { consumeRateLimit, type RateLimitDatabase } from "../../src/server/security/rate-limit.ts";

afterEach(() => vi.unstubAllEnvs());

describe("senhas", () => {
  it("exige de 12 a 128 caracteres e preserva espaços", () => {
    expect(passwordSchema.safeParse("a".repeat(11)).success).toBe(false);
    expect(passwordSchema.safeParse("a".repeat(12)).success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(128)).success).toBe(true);
    expect(passwordSchema.safeParse("a".repeat(129)).success).toBe(false);
    expect(passwordSchema.parse("  uma senha longa  ")).toBe("  uma senha longa  ");
  });

  it("gera salts distintos e verifica somente a senha correta", async () => {
    const password = "uma senha de teste longa";
    const first = await hashPassword(password);
    const second = await hashPassword(password);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^scrypt\$v1\$32768\$8\$3\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(first).not.toContain(password);
    expect(await verifyPassword(first, password)).toBe(true);
    expect(await verifyPassword(first, "outra senha de teste longa")).toBe(false);
  });

  it("não remove espaços durante o hash ou a verificação", async () => {
    const password = "  minha senha com espaços  ";
    const hash = await hashPassword(password);
    expect(await verifyPassword(hash, password)).toBe(true);
    expect(await verifyPassword(hash, password.trim())).toBe(false);
  });

  it("rejeita hashes malformados e parâmetros de custo não reconhecidos", async () => {
    const suffix = `${"a".repeat(32)}$${"b".repeat(128)}`;
    for (const hash of ["", "texto", "x".repeat(500), `scrypt$v1$1048576$8$3$${suffix}`, `scrypt$v1$32768$8$3$${suffix}extra`]) {
      expect(await verifyPassword(hash, "uma senha longa válida")).toBe(false);
    }
  });

  it("recusa senha fora da política antes de criar um hash", async () => {
    await expect(hashPassword("curta")).rejects.toThrow();
  });
});

describe("limites compartilhados", () => {
  const parts = ["login", "conta@example.invalid", "192.0.2.10"];

  it("envia somente a chave HMAC, nunca o e-mail ou IP em claro", async () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(40));
    const query = vi.fn().mockResolvedValue([{ count: 1, retryAfter: 60 }]);
    const db = { $queryRaw: query } as unknown as RateLimitDatabase;
    expect(await consumeRateLimit(parts, 3, 60, db)).toEqual({ allowed: true, retryAfter: 0 });
    const bindings = query.mock.calls[0].slice(1);
    expect(bindings).not.toContain(parts[1]);
    expect(bindings).not.toContain(parts[2]);
    expect(bindings[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("bloqueia ao ultrapassar o limite e informa o tempo restante", async () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(40));
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ count: 4, retryAfter: 17 }]) } as unknown as RateLimitDatabase;
    expect(await consumeRateLimit(parts, 3, 60, db)).toEqual({ allowed: false, retryAfter: 17 });
  });

  it("falha fechado se o armazenamento compartilhado estiver indisponível", async () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(40));
    const db = { $queryRaw: vi.fn().mockRejectedValue(new Error("driver indisponível")) } as unknown as RateLimitDatabase;
    expect(await consumeRateLimit(parts, 3, 60, db)).toEqual({ allowed: false, retryAfter: 60 });
  });

  it("não consulta o banco sem segredo válido ou com limites inválidos", async () => {
    const query = vi.fn();
    const db = { $queryRaw: query } as unknown as RateLimitDatabase;
    vi.stubEnv("AUTH_SECRET", "");
    expect((await consumeRateLimit(parts, 3, 60, db)).allowed).toBe(false);
    vi.stubEnv("AUTH_SECRET", "a".repeat(40));
    expect((await consumeRateLimit(parts, 0, 60, db)).allowed).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
