import "server-only";
import type { MovementResult } from "../../lib/stock/types.ts";
import { requireApiIdentity, type Principal } from "../auth/identity.ts";
import { assertTrustedHost, errorResponse, limitRequest, readJson } from "../security/http.ts";

type ItemContext = { params: Promise<{ id: string }> };
const headers = { "Cache-Control": "no-store" };

export function stockRead<T>(read: (actor: Principal, query: URLSearchParams) => Promise<T>) {
  return async function GET(request: Request) {
    try {
      assertTrustedHost(request);
      const actor = await requireApiIdentity(request);
      await limitRequest(request, "stock-read", 240, 60, actor.id);
      return Response.json(await read(actor, new URL(request.url).searchParams), { headers });
    } catch (error) { return errorResponse(error); }
  };
}
export function stockItemRead<T>(read: (actor: Principal, id: string) => Promise<T>) {
  return async function GET(request: Request, context: ItemContext) {
    try {
      assertTrustedHost(request);
      const actor = await requireApiIdentity(request);
      await limitRequest(request, "stock-read", 240, 60, actor.id);
      const { id } = await context.params;
      return Response.json(await read(actor, id), { headers });
    } catch (error) { return errorResponse(error); }
  };
}
function resultResponse(result: MovementResult) {
  return Response.json(result, { status: result.replayed ? 200 : 201, headers });
}
export function stockWrite(write: (actor: Principal, body: unknown) => Promise<MovementResult>) {
  return async function POST(request: Request) {
    try {
      const body = await readJson(request);
      const actor = await requireApiIdentity(request);
      await limitRequest(request, "stock-write", 120, 60, actor.id);
      return resultResponse(await write(actor, body));
    } catch (error) { return errorResponse(error); }
  };
}
export function stockItemWrite(write: (actor: Principal, id: string, body: unknown) => Promise<MovementResult>) {
  return async function POST(request: Request, context: ItemContext) {
    try {
      const body = await readJson(request);
      const actor = await requireApiIdentity(request);
      await limitRequest(request, "stock-write", 120, 60, actor.id);
      const { id } = await context.params;
      return resultResponse(await write(actor, id, body));
    } catch (error) { return errorResponse(error); }
  };
}
