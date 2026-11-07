import { requireApiIdentity } from "@/server/auth/identity";
import { assertTrustedHost, errorResponse, limitRequest } from "@/server/security/http";
import { getReportPreview } from "@/server/transfers/export-service";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedHost(request); const actor = await requireApiIdentity(request);
    await limitRequest(request, "exports-read", 120, 60, actor.id);
    return Response.json(await getReportPreview(actor, (await context.params).id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
