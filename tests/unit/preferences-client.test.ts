import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, preferenceResult, readPreferences, savePreferences } from "../../src/components/preferences/preferences-api.ts";

afterEach(() => { vi.unstubAllGlobals(); });
describe("preferências no navegador", () => {
  it("aplica o modo salvo sem depender de armazenamento local ou fixar o tema do sistema", () => {
    const dataset: Record<string, string> = {};
    const dispatchEvent = vi.fn();
    vi.stubGlobal("document", { documentElement: { dataset } }); vi.stubGlobal("window", { dispatchEvent });
    applyTheme("system");
    expect(dataset.theme).toBe("system"); expect(dispatchEvent.mock.calls[0][0].type).toBe("prevision:theme-changed");
    applyTheme("dark"); expect(dataset.theme).toBe("dark");
  });
  it.each([null, {}, { theme: "other", version: 0 }, { theme: "dark", version: -1 }, { theme: "dark", version: "0" }])("não aplica resposta inválida", (body) => expect(() => preferenceResult(body)).toThrow());
  it("leitura e gravação usam a conta autenticada sem enviar um proprietário arbitrário", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ theme: "dark", version: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetch); vi.stubGlobal("document", { cookie: "prevision.csrf=local-challenge" });
    expect(await readPreferences()).toEqual({ theme: "dark", version: 1 });
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ theme: "light", version: 2 }), { status: 200 }));
    expect(await savePreferences("light", 1)).toEqual({ theme: "light", version: 2 });
    expect(fetch.mock.calls[1][0]).toBe("/api/preferences");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ theme: "light", expectedVersion: 1 });
    expect(fetch.mock.calls[1][1].headers["X-Prevision-CSRF"]).toBe("local-challenge");
  });
});
