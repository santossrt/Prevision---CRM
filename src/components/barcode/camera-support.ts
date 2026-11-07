export const requestedBarcodeFormats = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "codabar"] as const;

export interface DetectedBarcode { rawValue: string }
export interface BarcodeDetectorInstance { detect(source: HTMLVideoElement): Promise<DetectedBarcode[]> }
export interface BarcodeDetectorConstructor {
  new(options: { formats: string[] }): BarcodeDetectorInstance;
  getSupportedFormats(): Promise<string[]>;
}
export function supportedBarcodeFormats(formats: readonly string[]): string[] {
  return requestedBarcodeFormats.filter((format) => formats.includes(format));
}

/** Both browser tracks and the video reference must be released on every exit. */
export function releaseCamera(stream: Pick<MediaStream, "getTracks"> | null, video: Pick<HTMLVideoElement, "srcObject" | "pause"> | null): void {
  if (stream) for (const track of stream.getTracks()) track.stop();
  if (video) { video.pause(); video.srcObject = null; }
}

export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "A câmera não foi autorizada. Você pode continuar digitando ou usando um leitor USB.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Nenhuma câmera compatível foi encontrada. Use o campo de código ou um leitor USB.";
  if (name === "NotReadableError") return "Não foi possível acessar a câmera. Ela pode estar em uso em outro aplicativo.";
  return "Não foi possível iniciar ou continuar a leitura pela câmera. Use o campo de código ou um leitor USB.";
}
