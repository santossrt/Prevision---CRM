import { requireApiIdentity } from "@/server/auth/identity";
import { assertTrustedHost, errorResponse, limitRequest } from "@/server/security/http";
import { downloadReport } from "@/server/transfers/export-service";
import { downloadFormat } from "@/server/transfers/export-validation";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertTrustedHost(request); const actor = await requireApiIdentity(request);
    await limitRequest(request, "exports-download", 30, 900, actor.id);
    const result = await downloadReport(actor, (await context.params).id, downloadFormat(new URL(request.url).searchParams));
    return new Response(new Uint8Array(result.buffer), { headers: {
      "Content-Type": result.contentType, "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Length": String(result.buffer.length)
    } });
  } catch (error) { return errorResponse(error); }
}
