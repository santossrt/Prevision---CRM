import { listProductValues } from "@/server/catalog/service";
import { requireApiIdentity } from "@/server/auth/identity";
import { assertTrustedHost, errorResponse, limitRequest } from "@/server/security/http";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedHost(request);
    const actor = await requireApiIdentity(request);
    await limitRequest(request, "catalog-values-read", 120, 60, actor.id);
    const { id } = await context.params;
    return Response.json(await listProductValues(actor, id, new URL(request.url).searchParams), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
