import "server-only";
import { ApplicationError } from "../errors/application-error.ts";

export type BodyReadReason = "TOO_LARGE" | "INVALID_LENGTH" | "TIMEOUT" | "ABORTED" | "UNREADABLE";
export class BodyReadError extends ApplicationError {
  constructor(readonly reason: BodyReadReason) {
    super("VALIDATION", reason === "TOO_LARGE" ? "Solicitação muito grande."
      : reason === "TIMEOUT" ? "O tempo de leitura da solicitação foi excedido."
        : reason === "ABORTED" ? "A leitura da solicitação foi interrompida." : "Solicitação inválida.");
  }
}

/** Read bytes once, with an enforced cap and deadline. Cancellation must not
 * await an uncooperative stream's underlying cancel callback. */
export async function readBoundedBody(request: Request, maximumBytes: 16384 | 65536, timeoutMs = 10000): Promise<Buffer> {
  if (![16384, 65536].includes(maximumBytes) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new BodyReadError("UNREADABLE");
  const cancelBody = () => { void request.body?.cancel().catch(() => {}); };
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length.trim()) || !Number.isSafeInteger(Number(length)))) {
    cancelBody(); throw new BodyReadError("INVALID_LENGTH");
  }
  if (length !== null && Number(length) > maximumBytes) { cancelBody(); throw new BodyReadError("TOO_LARGE"); }
  if (request.signal.aborted) { cancelBody(); throw new BodyReadError("ABORTED"); }
  if (!request.body) return Buffer.alloc(0);

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = request.body.getReader(); } catch { throw new BodyReadError("UNREADABLE"); }
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let interruption: BodyReadError | undefined;
  let rejectInterrupted!: (reason: BodyReadError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
  const interrupt = (reason: "TIMEOUT" | "ABORTED") => {
    if (interruption) return;
    interruption = new BodyReadError(reason);
    rejectInterrupted(interruption);
    cancel();
  };
  const abort = () => interrupt("ABORTED");
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => interrupt("TIMEOUT"), timeoutMs);
  const chunks: Buffer[] = []; let size = 0;
  try {
    // The signal may have changed between the initial check and subscription.
    if (request.signal.aborted) interrupt("ABORTED");
    while (true) {
      const result = await Promise.race([reader.read(), interrupted]);
      if (interruption) throw interruption;
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) { cancel(); throw new BodyReadError("TOO_LARGE"); }
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    cancel();
    if (error instanceof BodyReadError) throw error;
    throw new BodyReadError("UNREADABLE");
  } finally {
    clearTimeout(timer); request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
