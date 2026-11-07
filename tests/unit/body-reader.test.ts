import { afterEach, describe, expect, it, vi } from "vitest";
import { readBoundedBody } from "../../src/server/security/body-reader.ts";

afterEach(() => vi.useRealTimers());
function streamRequest(stream: ReadableStream<Uint8Array>, signal?: AbortSignal, headers?: HeadersInit) {
  return new Request("http://127.0.0.1/body", { method: "POST", body: stream, signal, headers, duplex: "half" } as RequestInit);
}

describe("leitura limitada e prazo do corpo HTTP", () => {
  it("preserva bytes UTF-8 divididos entre chunks e aceita exatamente o teto", async () => {
    const source = new TextEncoder().encode("á".repeat(8192));
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(source.subarray(0, 1)); controller.enqueue(source.subarray(1)); controller.close(); } });
    expect((await readBoundedBody(streamRequest(stream), 16384)).toString()).toBe("á".repeat(8192));
  });

  it("não aguarda um cancelamento que nunca termina quando o corpo ultrapassa o teto", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(16385)); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
    await expect(readBoundedBody(streamRequest(stream), 16384)).rejects.toMatchObject({ reason: "TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  it("interrompe leitura parada no prazo mesmo se o cancelamento não responder", async () => {
    vi.useFakeTimers(); let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => {}); } });
    const pending = readBoundedBody(streamRequest(stream), 16384, 25);
    const rejected = expect(pending).rejects.toMatchObject({ reason: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(25); await rejected;
    expect(cancelled).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("cancela a leitura pendente quando o cliente aborta e remove o prazo", async () => {
    vi.useFakeTimers(); let cancelled = false; const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const rejected = expect(readBoundedBody(streamRequest(stream, controller.signal), 16384)).rejects.toMatchObject({ reason: "ABORTED" });
    controller.abort(); await rejected;
    expect(cancelled).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("não lê o corpo de uma solicitação já abortada", async () => {
    let read = 0; const controller = new AbortController(); controller.abort();
    const stream = new ReadableStream<Uint8Array>({ pull() { read++; } }, { highWaterMark: 0 });
    await expect(readBoundedBody(streamRequest(stream, controller.signal), 16384)).rejects.toMatchObject({ reason: "ABORTED" });
    expect(read).toBe(0);
  });

  it.each(["-1", "NaN", "1,2", "9007199254740993", ""])("rejeita Content-Length inválido antes de ler: %s", async (length) => {
    let read = 0; const stream = new ReadableStream<Uint8Array>({ pull() { read++; } }, { highWaterMark: 0 });
    await expect(readBoundedBody(streamRequest(stream, undefined, { "content-length": length }), 16384)).rejects.toMatchObject({ reason: "INVALID_LENGTH" });
    expect(read).toBe(0);
  });

  it("não retorna a mensagem interna de um stream quebrado", async () => {
    const stream = new ReadableStream<Uint8Array>({ pull() { throw new Error("private-driver-detail"); } });
    await expect(readBoundedBody(streamRequest(stream), 16384)).rejects.toMatchObject({ reason: "UNREADABLE", message: "Solicitação inválida." });
  });
});
