import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCsrfToken } from "../../src/server/security/csrf.ts";
import { assertCsrf, errorResponse, readJson } from "../../src/server/security/http.ts";

vi.mock("../../src/server/security/rate-limit.ts", () => ({ consumeRateLimit: vi.fn() }));

const secret = "segredo-exclusivo-para-teste-de-limite-json-0001";
const origin = "http://127.0.0.1:3000";
const chunkBytes = 4096;
const totalChunks = 64;
type Limit = 16384 | 65536;
const cases: [string, Limit, string | undefined][] = [
  ["16 KiB sem Content-Length", 16384, undefined],
  ["16 KiB com Content-Length menor", 16384, "2"],
  ["64 KiB sem Content-Length", 65536, undefined],
  ["64 KiB com Content-Length menor", 65536, "2"]
];

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", secret);
  vi.stubEnv("AUTH_URL", origin);
  vi.stubEnv("APP_ENV", "test");
  vi.stubEnv("MAIL_TRANSPORT", "local");
});
afterEach(() => vi.unstubAllEnvs());

function streamedRequest(contentLength?: string) {
  const stats = { chunksRead: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const index = stats.chunksRead++;
      // JSON válido de 256 KiB: a rejeição não depende de erro de sintaxe.
      const text = index === 0 ? `"${"a".repeat(chunkBytes - 1)}`
        : index === totalChunks - 1 ? `${"a".repeat(chunkBytes - 1)}"`
        : "a".repeat(chunkBytes);
      controller.enqueue(new TextEncoder().encode(text));
      if (stats.chunksRead === totalChunks) controller.close();
    },
    cancel() { stats.cancelled = true; }
  }, { highWaterMark: 0 });
  const token = createCsrfToken("", secret);
  const headers = new Headers({
    host: "127.0.0.1:3000", origin, "sec-fetch-site": "same-origin",
    "content-type": "application/json", "X-Prevision-CSRF": token,
    cookie: `prevision.csrf=${token}`
  });
  if (contentLength !== undefined) headers.set("content-length", contentLength);
  const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body: stream, duplex: "half" };
  return { request: new Request(`${origin}/api/access/password-reset/request`, init), stats };
}

async function expectOversizedRejected(request: Request, limit: Limit) {
  expect(() => assertCsrf(request)).not.toThrow();
  const failure = await readJson(request, limit).then(() => null, (error: unknown) => error);
  expect(failure).toMatchObject({ code: "VALIDATION", message: "Solicitação muito grande." });
  expect(errorResponse(failure).status).toBe(400);
}

describe("limites de leitura do corpo JSON", () => {
  it.each(cases)("recusa o tamanho real com HTTP 400: %s", async (_label, limit, contentLength) => {
    const { request } = streamedRequest(contentLength);
    await expectOversizedRejected(request, limit);
  });

  it.each(cases)("cancela a leitura antes do fim em %s", async (_label, limit, contentLength) => {
    const { request, stats } = streamedRequest(contentLength);
    await expectOversizedRejected(request, limit);
    expect.soft(stats.cancelled, "O leitor deve cancelar o stream ao ultrapassar o teto.").toBe(true);
    expect(stats.chunksRead, "Não deve consumir o restante do corpo já considerado excessivo.").toBeLessThan(totalChunks);
  });

  it.each([16384, 65536] as const)("recusa Content-Length acima de %i antes de ler qualquer chunk", async (limit) => {
    const { request, stats } = streamedRequest(String(limit + 1));
    await expectOversizedRejected(request, limit);
    expect(stats.chunksRead).toBe(0);
    await request.body?.cancel();
  });
});
