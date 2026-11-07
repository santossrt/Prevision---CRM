import { NextResponse } from "next/server";
import { z } from "zod";
import { prepareGoogleLink } from "@/server/auth/access-tokens";
import { getRequestPrincipal } from "@/server/auth/identity";
import { getAuthSettings, sessionCookieName } from "@/server/auth/settings";
import { errorResponse, limitRequest, readJson } from "@/server/security/http";

export async function POST(request: Request) {
  try {
    const body = z.object({ activationToken: z.string().optional(), password: z.string().optional() }).strict().parse(await readJson(request));
    await limitRequest(request, "google-link", 10, 900);
    const principal = await getRequestPrincipal(request);
    const token = await prepareGoogleLink(principal, body.activationToken, body.password);
    const settings = getAuthSettings();
    const response = NextResponse.json({ message: "Vinculação preparada. Continue com o Google." });
    response.cookies.set("prevision.google-link", token, { httpOnly: true, secure: settings.secure, sameSite: "lax", path: "/", maxAge: 600 });
    if (!principal && body.activationToken) {
      for (const part of (request.headers.get("cookie") ?? "").split(";")) {
        const name = part.trim().split("=")[0];
        if (name === sessionCookieName() || name.startsWith(sessionCookieName() + ".")) response.cookies.set(name, "", { httpOnly: true, secure: settings.secure, sameSite: "lax", path: "/", maxAge: 0 });
      }
    }
    return response;
  } catch (error) { return errorResponse(error); }
}
