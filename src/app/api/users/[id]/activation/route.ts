import { requireApiIdentity } from "@/server/auth/identity";
import { resendActivation } from "@/server/users/service";
import { errorResponse, limitRequest, readJson } from "@/server/security/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await readJson(request);
    const actor = await requireApiIdentity(request);
    await limitRequest(request, "users-activation", 10, 900, actor.id);
    await resendActivation(actor, (await context.params).id);
    return Response.json({ message: "Instruções de ativação enviadas." });
  } catch (error) { return errorResponse(error); }
}
