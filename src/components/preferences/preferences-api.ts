"use client";
import { catalogRequest } from "@/components/catalog/catalog-api";
import { themeModes, type ThemeMode, type UserPreferenceDTO } from "@/lib/preferences/types";

export function preferenceResult(value: unknown): UserPreferenceDTO {
  if (!value || typeof value !== "object" || !("theme" in value) || !("version" in value)
    || typeof value.theme !== "string" || !(themeModes as readonly string[]).includes(value.theme)
    || typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 0) {
    throw new Error("Não foi possível conferir suas preferências. Recarregue e tente novamente.");
  }
  return { theme: value.theme as ThemeMode, version: value.version };
}

export async function readPreferences(signal?: AbortSignal) {
  return preferenceResult(await catalogRequest<unknown>("/api/preferences", { signal }));
}
export async function savePreferences(theme: ThemeMode, expectedVersion: number) {
  return preferenceResult(await catalogRequest<unknown>("/api/preferences", { method: "PATCH", body: { theme, expectedVersion } }));
}
export function applyTheme(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new Event("prevision:theme-changed"));
}
