/** Liveness público: não consulta banco e não expõe configuração ou credenciais. */
export function GET() {
  return Response.json({ status: "ok", service: "prevision" }, {
    headers: { "Cache-Control": "no-store" }
  });
}
