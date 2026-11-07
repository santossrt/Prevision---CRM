import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../src/server/auth/identity.ts";
import { parsePreferenceUpdate } from "../../src/server/preferences/validation.ts";
import { getUserPreference, updateUserPreference } from "../../src/server/preferences/service.ts";
import { preferenceResponse } from "../../src/server/preferences/http.ts";

const state = vi.hoisted(() => ({ database: {} as Record<string, unknown>, current: vi.fn(), verify: vi.fn(), secure: false }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => state.database }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: state.verify }));
vi.mock("../../src/server/auth/identity.ts", () => ({ identityInclude: { user: true }, principalFromSession: state.current }));
vi.mock("../../src/server/auth/settings.ts", () => ({ getAuthSettings: () => ({ secure: state.secure }) }));

const actorId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";
const actor = { id: actorId, sessionId, sessionVersion: 3, permissions: [] } as unknown as Principal;
function fixture() {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    loginSession: { findUnique: vi.fn().mockResolvedValue({ user: {} }) },
    userPreference: { findUnique: vi.fn().mockResolvedValue({ theme: "dark", version: 4 }), upsert: vi.fn().mockResolvedValue({ theme: "system", version: 0 }), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
  };
  state.database = { $transaction: vi.fn(async (work: (transaction: typeof tx) => unknown) => work(tx)) };
  return tx;
}
beforeEach(() => { state.current.mockReset().mockReturnValue(actor); state.verify.mockReset().mockResolvedValue(undefined); state.secure = false; });

describe("preferência individual de aparência", () => {
  it("consulta somente o usuário da sessão e não exige permissão administrativa", async () => {
    const tx = fixture();
    expect(await getUserPreference(actor)).toEqual({ theme: "dark", version: 4 });
    expect(tx.userPreference.findUnique).toHaveBeenCalledWith({ where: { userId: actorId } });
    expect(state.current).toHaveBeenCalledWith({ user: {} }, { sub: actorId, version: 3 });
  });
  it("usa sistema como padrão sem gravar durante consulta", async () => {
    const tx = fixture(); tx.userPreference.findUnique.mockResolvedValueOnce(null as never);
    expect(await getUserPreference(actor)).toEqual({ theme: "system", version: 0 });
    expect(tx.userPreference.upsert).not.toHaveBeenCalled();
  });
  it.each(["get", "save"])("revalida sessão revogada antes de %s", async (kind) => {
    const tx = fixture(); state.current.mockReturnValueOnce(null);
    await expect(kind === "get" ? getUserPreference(actor) : updateUserPreference(actor, { theme: "dark", expectedVersion: 0 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(tx.userPreference.findUnique).not.toHaveBeenCalled(); expect(tx.userPreference.upsert).not.toHaveBeenCalled();
  });
  it("não aceita tema persistido desconhecido silenciosamente", async () => {
    const tx = fixture(); tx.userPreference.findUnique.mockResolvedValueOnce({ theme: "external", version: 0 });
    await expect(getUserPreference(actor)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  it("primeira gravação e atualizações mantêm versão e proprietário da sessão", async () => {
    const tx = fixture();
    expect(await updateUserPreference(actor, { theme: "light", expectedVersion: 0 })).toEqual({ theme: "light", version: 1 });
    expect(tx.userPreference.upsert).toHaveBeenCalledWith({ where: { userId: actorId }, create: { userId: actorId, theme: "system" }, update: {} });
    expect(tx.userPreference.updateMany).toHaveBeenCalledWith({ where: { userId: actorId, version: 0 }, data: { theme: "light", version: { increment: 1 } } });
  });
  it("edição concorrente exige recarregar sem retornar uma preferência não confirmada", async () => {
    const tx = fixture(); tx.userPreference.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(updateUserPreference(actor, { theme: "dark", expectedVersion: 3 })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it.each([
    {}, { theme: "sepia", expectedVersion: 0 }, { theme: "dark", expectedVersion: -1 }, { theme: "dark", expectedVersion: 1.5 },
    { theme: "dark", expectedVersion: "0" }, { theme: "dark", expectedVersion: 2147483647 }, { theme: "dark", expectedVersion: 0, userId: "another-user" }
  ])("recusa contrato inválido ou escolha de outro usuário", async (body) => {
    const tx = fixture();
    expect(() => parsePreferenceUpdate(body)).toThrow();
    await expect(updateUserPreference(actor, body)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(tx.loginSession.findUnique).not.toHaveBeenCalled();
  });
  it("resposta e cookie transportam apenas preferência, sem identificadores ou credenciais", async () => {
    const response = preferenceResponse({ theme: "dark", version: 1 });
    expect(await response.json()).toEqual({ theme: "dark", version: 1 });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBe("prevision.theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly");
    state.secure = true;
    expect(preferenceResponse({ theme: "system", version: 1 }).headers.get("set-cookie")).toContain("; Secure");
  });
});
