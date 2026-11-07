import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestTheme } from "../../src/server/preferences/request-theme.ts";

const state = vi.hoisted(() => ({ cookie: "light", principal: vi.fn(), preference: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "prevision.theme" ? { value: state.cookie } : undefined }) }));
vi.mock("../../src/server/auth/identity.ts", () => ({ getRequestPrincipal: state.principal }));
vi.mock("../../src/server/preferences/service.ts", () => ({ getUserPreference: state.preference }));

beforeEach(() => { state.cookie = "light"; state.principal.mockReset().mockResolvedValue(null); state.preference.mockReset().mockResolvedValue({ theme: "dark", version: 2 }); });

describe("aparência no primeiro render", () => {
  it("usa a preferência da conta atual em vez do tema de uma conta anterior no navegador", async () => {
    const actor = { id: "current-user" }; state.principal.mockResolvedValueOnce(actor);
    expect(await requestTheme()).toBe("dark"); expect(state.preference).toHaveBeenCalledWith(actor);
  });
  it("conta sem escolha usa sistema mesmo quando o navegador conserva escolha explícita", async () => {
    state.principal.mockResolvedValueOnce({ id: "new-user" }); state.preference.mockResolvedValueOnce({ theme: "system", version: 0 });
    expect(await requestTheme()).toBe("system");
  });
  it("página pública usa somente cookie de modo conhecido, sem consultar preferências de outro usuário", async () => {
    expect(await requestTheme()).toBe("light"); expect(state.preference).not.toHaveBeenCalled();
    state.cookie = "unknown"; expect(await requestTheme()).toBe("system");
  });
  it("uma falha de configuração ou banco não impede a página de acesso de renderizar", async () => {
    state.cookie = "dark"; state.principal.mockRejectedValueOnce(new Error("unavailable"));
    expect(await requestTheme()).toBe("dark");
  });
});
