import { errorResponse, importActor, importHeaders, readImportUpload } from "@/server/transfers/import-http";
import { previewProductImport } from "@/server/transfers/import-service";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const actor = await importActor(request, true);
    const upload = await readImportUpload(request);
    return Response.json(await previewProductImport(actor, upload.fileName, upload.buffer, upload.format), { status: 201, headers: importHeaders });
  } catch (error) { return errorResponse(error); }
}
