import "server-only";
import { requireApiIdentity, type Principal } from "../auth/identity.ts";
import { assertTrustedHost, errorResponse, limitRequest } from "../security/http.ts";

const headers = { "Cache-Control": "no-store" };
export function auditRead<T>(read: (actor: Principal, query: URLSearchParams) => Promise<T>) {
  return async function GET(request: Request) {
    try {
      assertTrustedHost(request);
      const actor = await requireApiIdentity(request);
      await limitRequest(request, "audit-read", 180, 60, actor.id);
      return Response.json(await read(actor, new URL(request.url).searchParams), { headers });
    } catch (error) { return errorResponse(error); }
  };
}
export function auditItemRead<T>(read: (actor: Principal, id: string) => Promise<T>) {
  return async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
    try {
      assertTrustedHost(request);
      const actor = await requireApiIdentity(request);
      await limitRequest(request, "audit-read", 180, 60, actor.id);
      const { id } = await context.params;
      return Response.json(await read(actor, id), { headers });
    } catch (error) { return errorResponse(error); }
  };
}
