import { errorResponse, importActor, importHeaders } from "@/server/transfers/import-http";
import { importTemplate } from "@/server/transfers/import-parser";
import { ApplicationError } from "@/server/errors/application-error";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    await importActor(request); const query = new URL(request.url).searchParams;
    const format = query.get("format");
    if (query.size !== 1 || format !== "csv" && format !== "xlsx") throw new ApplicationError("VALIDATION", "Escolha o modelo CSV ou XLSX.");
    const buffer = await importTemplate(format);
    return new Response(new Uint8Array(buffer), { headers: { ...importHeaders, "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="prevision-modelo-produtos.${format}"` } });
  } catch (error) { return errorResponse(error); }
}
