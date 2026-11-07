import { errorResponse, importActor, importHeaders } from "@/server/transfers/import-http";
import { getProductImport, ImportPreviewExpiredError } from "@/server/transfers/import-service";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const actor = await importActor(request); const { id } = await context.params; return Response.json(await getProductImport(actor, id), { headers: importHeaders }); }
  catch (error) {
    if (error instanceof ImportPreviewExpiredError) return Response.json({ message: error.message, code: "IMPORT_PREVIEW_EXPIRED" }, { status: 409, headers: importHeaders });
    const response = errorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
