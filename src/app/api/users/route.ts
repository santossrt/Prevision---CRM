import { requireApiIdentity } from "@/server/auth/identity";
import { createUser, listUsers } from "@/server/users/service";
import { assertTrustedHost, errorResponse, limitRequest, readJson } from "@/server/security/http";

export async function GET(request: Request) {
  try {
    assertTrustedHost(request);
    const actor = await requireApiIdentity(request);
    await limitRequest(request, "users-read", 120, 60, actor.id);
    return Response.json(await listUsers(actor), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const body = await readJson(request);
    const actor = await requireApiIdentity(request);
    await limitRequest(request, "users-write", 30, 60, actor.id);
    const user = await createUser(actor, body);
    return Response.json({ user, message: "Usuário cadastrado. Instruções de ativação enviadas." }, { status: 201 });
  } catch (error) { return errorResponse(error); }
}
