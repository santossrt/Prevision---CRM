import { NextResponse } from "next/server";
import { getRequestPrincipal } from "@/server/auth/identity";
import { getAuthSettings, sessionCookieName } from "@/server/auth/settings";
import { revokeLoginSession } from "@/server/auth/sessions";
import { errorResponse, readJson } from "@/server/security/http";

export async function POST(request: Request) {
  try {
    await readJson(request);
    const principal = await getRequestPrincipal(request);
    if (principal) await revokeLoginSession(principal.sessionId, principal.id);
    const response = NextResponse.json({ message: "Sessão encerrada." });
    const settings = getAuthSettings();
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
      const name = part.trim().split("=")[0];
      if (name === sessionCookieName() || name.startsWith(sessionCookieName() + ".") || name === "prevision.google-link") response.cookies.set(name, "", { httpOnly: true, secure: settings.secure, sameSite: "lax", path: "/", maxAge: 0 });
    }
    return response;
  } catch (error) { return errorResponse(error); }
}
