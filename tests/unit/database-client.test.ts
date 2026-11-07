import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  constructor: undefined as unknown,
  create: vi.fn(),
  adapter: vi.fn(),
  environment: vi.fn()
}));
vi.mock("../../src/generated/prisma/client.ts", () => ({ get PrismaClient() { return state.constructor; } }));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: class { constructor(options: unknown) { state.adapter(options); } } }));
vi.mock("../../src/server/config/environment.ts", () => ({ readEnvironment: state.environment }));

const cache = globalThis as unknown as {
  previsionDatabaseClients?: WeakMap<object, object>;
  previsionDatabase?: object;
};

function generatedConstructor() {
  return class {
    $disconnect = vi.fn();
    constructor(options: unknown) { state.create(options); }
  };
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "development");
  vi.resetModules();
  delete cache.previsionDatabaseClients;
  delete cache.previsionDatabase;
  state.constructor = generatedConstructor();
  state.environment.mockReturnValue({ DATABASE_URL: "postgresql://app:only-a-test@127.0.0.1/prevision_test" });
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete cache.previsionDatabaseClients;
  delete cache.previsionDatabase;
});

describe("cache do cliente Prisma durante recarga do servidor", () => {
  it("não lê configuração nem abre cliente durante importação", async () => {
    await import("../../src/server/database/client.ts");
    expect(state.environment).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("reutiliza o mesmo cliente após recarregar o módulo com o mesmo construtor", async () => {
    const firstModule = await import("../../src/server/database/client.ts");
    const first = firstModule.getDatabase();
    vi.resetModules();
    const reloadedModule = await import("../../src/server/database/client.ts");
    expect(reloadedModule.getDatabase()).toBe(first);
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it("usa o cliente regenerado sem interromper requisições no cliente anterior", async () => {
    const { getDatabase } = await import("../../src/server/database/client.ts");
    const originalConstructor = state.constructor;
    const first = getDatabase();
    state.constructor = generatedConstructor();
    const regenerated = getDatabase();
    expect(regenerated).not.toBe(first);
    expect(getDatabase()).toBe(regenerated);
    expect(first.$disconnect).not.toHaveBeenCalled();
    // Bundles RSC e Route Handler podem ter construtores distintos. Alternar
    // entre eles deve reutilizar as instâncias, sem criar pools a cada pedido.
    state.constructor = originalConstructor;
    expect(getDatabase()).toBe(first);
    expect(state.create).toHaveBeenCalledTimes(2);
  });

  it("ignora o singleton legado cujo schema não pode ser verificado", async () => {
    const legacy = { $disconnect: vi.fn() };
    cache.previsionDatabase = legacy;
    const { getDatabase } = await import("../../src/server/database/client.ts");
    expect(getDatabase()).not.toBe(legacy);
    expect(legacy.$disconnect).not.toHaveBeenCalled();
    expect(state.create).toHaveBeenCalledTimes(1);
  });

  it("mantém um único pool em produção entre os bundles do servidor", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { getDatabase } = await import("../../src/server/database/client.ts");
    const first = getDatabase();
    state.constructor = generatedConstructor();
    expect(getDatabase()).toBe(first);
    expect(state.create).toHaveBeenCalledTimes(1);
    expect(cache.previsionDatabaseClients).toBeUndefined();
  });
});
