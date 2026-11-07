import { requireApiIdentity } from "@/server/auth/identity";
import { getAnalyses } from "@/server/analyses/service";
import { assertTrustedHost, errorResponse, limitRequest } from "@/server/security/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    assertTrustedHost(request);
    const actor = await requireApiIdentity(request);
    await limitRequest(request, "analyses-read", 60, 60, actor.id);
    return Response.json(await getAnalyses(actor, new URL(request.url).searchParams), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error); response.headers.set("Cache-Control", "no-store"); return response;
  }
}
