import { z } from "zod";
import { confirmPassword } from "@/server/auth/access-tokens";
import { errorResponse, limitRequest, readJson } from "@/server/security/http";

export async function POST(request: Request) {
  try {
    await limitRequest(request, "password-confirm", 15, 900);
    const body = z.object({ token: z.string(), password: z.string() }).strict().parse(await readJson(request));
    await confirmPassword(body.token, body.password, "PASSWORD_RESET");
    return Response.json({ message: "Senha redefinida com sucesso." }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
