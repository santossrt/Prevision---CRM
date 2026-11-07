import { requireApiIdentity } from "@/server/auth/identity";
import { getUserPreference, updateUserPreference } from "@/server/preferences/service";
import { preferenceResponse } from "@/server/preferences/http";
import { errorResponse, limitRequest, readJson } from "@/server/security/http";

export const runtime = "nodejs";

function failure(error: unknown) {
  const response = errorResponse(error);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
export async function GET(request: Request) {
  try {
    const actor = await requireApiIdentity(request);
    await limitRequest(request, "preferences-read", 120, 60, actor.id);
    return preferenceResponse(await getUserPreference(actor));
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    const body = await readJson(request);
    const actor = await requireApiIdentity(request);
    await limitRequest(request, "preferences-write", 60, 60, actor.id);
    return preferenceResponse(await updateUserPreference(actor, body));
  } catch (error) { return failure(error); }
}
