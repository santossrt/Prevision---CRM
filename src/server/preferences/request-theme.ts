import "server-only";
import { cookies } from "next/headers";
import type { ThemeMode } from "../../lib/preferences/types.ts";
import { getRequestPrincipal } from "../auth/identity.ts";
import { getUserPreference } from "./service.ts";
import { themeCookieName } from "./http.ts";
import { validTheme } from "./validation.ts";

export async function requestTheme(): Promise<ThemeMode> {
  const value = (await cookies()).get(themeCookieName)?.value;
  const fallback = validTheme(value) ? value as ThemeMode : "system";
  try {
    const actor = await getRequestPrincipal();
    if (actor) return (await getUserPreference(actor)).theme;
  } catch {
    // Appearance must not prevent rendering an access/error page if the
    // database or session configuration is temporarily unavailable.
  }
  return fallback;
}
