import "server-only";
import { requireApiIdentity, type Principal } from "../auth/identity.ts";
import { assertTrustedHost, errorResponse, limitRequest, readJson } from "../security/http.ts";

type ItemContext = { params: Promise<{ id: string }> };
const privateHeaders = { "Cache-Control": "no-store" };

export function catalogReadHandler<T>(operation: string, read: (actor: Principal, query: URLSearchParams) => Promise<T>) {
  return async function GET(request: Request) {
    try {
      assertTrustedHost(request);
      const actor = await requireApiIdentity(request);
      await limitRequest(request, `catalog-${operation}-read`, 120, 60, actor.id);
      return Response.json(await read(actor, new URL(request.url).searchParams), { headers: privateHeaders });
    } catch (error) { return errorResponse(error); }
  };
}

export function catalogCollectionHandlers<T, L>(operation: string, label: string, list: (actor: Principal, query: URLSearchParams) => Promise<L>, create: (actor: Principal, input: unknown) => Promise<T>) {
  return {
    GET: catalogReadHandler(operation, list),
    async POST(request: Request) {
      try {
        const body = await readJson(request);
        const actor = await requireApiIdentity(request);
        await limitRequest(request, `catalog-${operation}-write`, 60, 60, actor.id);
        const item = await create(actor, body);
        return Response.json({ item, message: `Cadastro de ${label.toLocaleLowerCase("pt-BR")} realizado com sucesso.` }, { status: 201, headers: privateHeaders });
      } catch (error) { return errorResponse(error); }
    }
  };
}

export function catalogItemHandlers<T>(operation: string, get: (actor: Principal, id: string) => Promise<T>, update: (actor: Principal, id: string, input: unknown) => Promise<T>) {
  return {
    async GET(request: Request, context: ItemContext) {
      try {
        assertTrustedHost(request);
        const actor = await requireApiIdentity(request);
        await limitRequest(request, `catalog-${operation}-read`, 120, 60, actor.id);
        const { id } = await context.params;
        return Response.json({ item: await get(actor, id) }, { headers: privateHeaders });
      } catch (error) { return errorResponse(error); }
    },
    async PATCH(request: Request, context: ItemContext) {
      try {
        const body = await readJson(request);
        const actor = await requireApiIdentity(request);
        await limitRequest(request, `catalog-${operation}-write`, 60, 60, actor.id);
        const { id } = await context.params;
        return Response.json({ item: await update(actor, id, body), message: "Cadastro atualizado com sucesso." }, { headers: privateHeaders });
      } catch (error) { return errorResponse(error); }
    }
  };
}
