import "server-only";
import { getAuthSettings } from "../auth/settings.ts";
import type { UserPreferenceDTO } from "../../lib/preferences/types.ts";

export const themeCookieName = "prevision.theme";
export function preferenceResponse(preference: UserPreferenceDTO) {
  const secure = getAuthSettings().secure ? "; Secure" : "";
  return Response.json(preference, { headers: {
    "Cache-Control": "no-store", Vary: "Cookie",
    // This cookie is only a presentation hint for public pages. Authenticated
    // rendering resolves the current user's database preference instead.
    "Set-Cookie": `${themeCookieName}=${preference.theme}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`
  } });
}
