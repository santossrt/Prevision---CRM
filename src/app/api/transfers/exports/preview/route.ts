import { requireApiIdentity } from "@/server/auth/identity";
import { errorResponse, limitRequest, readJson } from "@/server/security/http";
import { createReportPreview } from "@/server/transfers/export-service";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const body = await readJson(request); const actor = await requireApiIdentity(request);
    await limitRequest(request, "exports-preview", 20, 900, actor.id);
    return Response.json(await createReportPreview(actor, body), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
