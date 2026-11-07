import { z } from "zod";
import { requireApiIdentity } from "@/server/auth/identity";
import { getAuthCapabilities } from "@/server/auth/settings";
import { ApplicationError } from "@/server/errors/application-error";
import { requestAdminPasswordReset } from "@/server/users/password-reset";
import { errorResponse, limitRequest, readJson } from "@/server/security/http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await readJson(request);
    const actor = await requireApiIdentity(request);
    if (actor.role !== "ADMINISTRATOR") throw new ApplicationError("FORBIDDEN", "Somente administradores podem solicitar a redefinição de senha de outro usuário.");
    z.object({}).strict().parse(body);
    const { id } = await context.params;
    await limitRequest(request, "admin-password-reset-actor", 30, 900, actor.id);
    await limitRequest(request, "admin-password-reset-target", 5, 1800, id);
    const result = await requestAdminPasswordReset(actor, id);
    const message = getAuthCapabilities().emailDelivery === "local"
      ? "Instruções de redefinição geradas na caixa de mensagens local. Nenhum e-mail foi enviado pela internet."
      : "Instruções de redefinição enviadas ao e-mail cadastrado do usuário.";
    return Response.json({ ...result, message }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
