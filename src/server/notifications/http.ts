import "server-only";
import { requireApiIdentity, type Principal } from "../auth/identity.ts";
import { assertTrustedHost, errorResponse, limitRequest, readJson } from "../security/http.ts";

function failure(error: unknown) {
  const response = errorResponse(error);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
export function notificationRead<T>(read: (actor: Principal, query: URLSearchParams) => Promise<T>) {
  return async (request: Request) => {
    try {
      assertTrustedHost(request);
      const actor = await requireApiIdentity(request);
      await limitRequest(request, "notifications-read", 120, 60, actor.id);
      return Response.json(await read(actor, new URL(request.url).searchParams), { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return failure(error); }
  };
}
export function notificationWrite<T>(write: (actor: Principal, body: unknown) => Promise<T>, operation = "notifications-write", limit = 120) {
  return async (request: Request) => {
    try {
      const body = await readJson(request); const actor = await requireApiIdentity(request);
      await limitRequest(request, operation, limit, 900, actor.id);
      const result = await write(actor, body);
      const status = operation === "notifications-notice" && !(result as { replayed?: boolean }).replayed ? 201 : 200;
      return Response.json(result, { status, headers: { "Cache-Control": "no-store" } });
    } catch (error) { return failure(error); }
  };
}
export function notificationItemWrite<T>(write: (actor: Principal, id: string, body: unknown) => Promise<T>) {
  return async (request: Request, context: { params: Promise<{ id: string }> }) => {
    try {
      const body = await readJson(request); const actor = await requireApiIdentity(request);
      await limitRequest(request, "notifications-write", 120, 900, actor.id);
      const { id } = await context.params;
      return Response.json(await write(actor, id, body), { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return failure(error); }
  };
}
