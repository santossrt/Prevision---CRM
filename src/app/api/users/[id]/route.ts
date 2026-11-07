import { requireApiIdentity } from "@/server/auth/identity";
import { updateUser } from "@/server/users/service";
import { errorResponse, limitRequest, readJson } from "@/server/security/http";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await readJson(request);
    const actor = await requireApiIdentity(request);
    await limitRequest(request, "users-write", 30, 60, actor.id);
    return Response.json({ user: await updateUser(actor, (await context.params).id, body), message: "Usuário atualizado." });
  } catch (error) { return errorResponse(error); }
}
