import "server-only";
import type { InventoryMutationResult } from "../../lib/inventory/types.ts";
import type { Principal } from "../auth/identity.ts";
import { requireApiIdentity } from "../auth/identity.ts";
import { errorResponse, limitRequest, readJson } from "../security/http.ts";

type ItemContext = { params: Promise<{ id: string }> };
const headers = { "Cache-Control": "no-store" };
export function inventoryCreate(write: (actor: Principal, body: unknown) => Promise<InventoryMutationResult>) {
  return async (request: Request) => {
    try {
      const body = await readJson(request, 65536);
      const actor = await requireApiIdentity(request);
      await limitRequest(request, "inventory-write", 120, 60, actor.id);
      const result = await write(actor, body);
      return Response.json(result, { status: result.replayed ? 200 : 201, headers });
    } catch (error) { return errorResponse(error); }
  };
}
export function inventoryWrite(write: (actor: Principal, id: string, body: unknown) => Promise<InventoryMutationResult>) {
  return async (request: Request, context: ItemContext) => {
    try {
      const body = await readJson(request, 65536);
      const actor = await requireApiIdentity(request);
      await limitRequest(request, "inventory-write", 120, 60, actor.id);
      const { id } = await context.params;
      return Response.json(await write(actor, id, body), { headers });
    } catch (error) { return errorResponse(error); }
  };
}
