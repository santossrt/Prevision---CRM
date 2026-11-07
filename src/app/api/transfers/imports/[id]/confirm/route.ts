import { errorResponse, importActor, importHeaders } from "@/server/transfers/import-http";
import { confirmProductImport, ImportPreviewExpiredError } from "@/server/transfers/import-service";
import { readJson } from "@/server/security/http";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await importActor(request, true); const body = await readJson(request); const { id } = await context.params;
    const result = await confirmProductImport(actor, id, body);
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: importHeaders });
  } catch (error) {
    if (error instanceof ImportPreviewExpiredError) return Response.json({ message: error.message, code: "IMPORT_PREVIEW_EXPIRED" }, { status: 409, headers: importHeaders });
    return errorResponse(error);
  }
}
