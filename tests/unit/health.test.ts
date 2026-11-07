import { expect, it } from "vitest";
import { GET } from "../../src/app/api/health/route";

it("liveness não expõe variáveis de ambiente", async () => {
  const response = GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "ok", service: "prevision" });
});
