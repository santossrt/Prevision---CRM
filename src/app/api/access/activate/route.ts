import { z } from "zod";
import { confirmPassword } from "@/server/auth/access-tokens";
import { errorResponse, limitRequest, readJson } from "@/server/security/http";

export async function POST(request: Request) {
  try {
    await limitRequest(request, "activation-confirm", 15, 900);
    const body = z.object({ token: z.string(), password: z.string() }).strict().parse(await readJson(request));
    await confirmPassword(body.token, body.password, "PASSWORD_SETUP");
    return Response.json({ message: "Acesso ativado. Entre com seu e-mail e senha." });
  } catch (error) { return errorResponse(error); }
}
