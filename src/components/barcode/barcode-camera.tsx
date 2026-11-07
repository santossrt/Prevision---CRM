"use client";
import { useEffect, useRef, useState } from "react";
import { cameraErrorMessage, releaseCamera, supportedBarcodeFormats, type BarcodeDetectorConstructor } from "./camera-support";
import styles from "./barcode.module.css";

export function BarcodeCamera({ onCode, onClose }: { onCode: (code: string) => void; onClose: (message?: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onCode, onClose });
  const [ready, setReady] = useState(false);
  useEffect(() => { callbacks.current = { onCode, onClose }; }, [onCode, onClose]);
  useEffect(() => {
    const video = videoRef.current;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      cancelled = true;
      clearTimeout(scanTimer); clearTimeout(timeout);
      stream?.getTracks().forEach((track) => track.removeEventListener("ended", ended));
      releaseCamera(stream, video); stream = null;
    };
    const close = (message: string) => { if (cancelled) return; cleanup(); callbacks.current.onClose(message); };
    const hidden = () => { if (document.hidden) close("A leitura foi encerrada ao sair desta aba. Clique em Ler com câmera para iniciar novamente."); };
    const ended = () => close("A câmera foi desconectada. Você pode iniciar novamente ou informar o código no campo.");
    document.addEventListener("visibilitychange", hidden);

    async function start() {
      const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !Detector?.getSupportedFormats) {
        close("A leitura por câmera não está disponível neste navegador ou endereço. Use o campo de código ou um leitor USB."); return;
      }
      try {
        const formats = supportedBarcodeFormats(await Detector.getSupportedFormats());
        if (cancelled) return;
        if (!formats.length) { close("Este navegador não oferece formatos de código de barras compatíveis. Use o campo de código ou um leitor USB."); return; }
        const detector = new Detector({ formats });
        const received = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
        if (cancelled) { releaseCamera(received, null); return; }
        stream = received;
        if (!video) { close("Não foi possível apresentar a câmera. Use o campo de código ou um leitor USB."); return; }
        stream.getTracks().forEach((track) => track.addEventListener("ended", ended));
        video.srcObject = stream;
        await video.play();
        if (cancelled) return;
        setReady(true);
        timeout = setTimeout(() => close("Nenhum código foi reconhecido em um minuto. A câmera foi desligada; tente novamente ou informe o código no campo."), 60000);
        async function scan() {
          if (cancelled) return;
          try {
            if (video && video.readyState >= 2) {
              const codes = await detector.detect(video);
              if (cancelled) return;
              const code = codes.find((item) => typeof item.rawValue === "string" && item.rawValue.trim())?.rawValue;
              if (code) { cleanup(); callbacks.current.onCode(code); return; }
            }
            scanTimer = setTimeout(() => void scan(), 200);
          } catch (error) { close(cameraErrorMessage(error)); }
        }
        void scan();
      } catch (error) { close(cameraErrorMessage(error)); }
    }
    if (document.hidden) hidden(); else void start();
    return () => { document.removeEventListener("visibilitychange", hidden); cleanup(); };
  }, []);

  return <div className={styles.camera} role="group" aria-label="Leitura de código pela câmera">
    <video ref={videoRef} muted playsInline autoPlay aria-label="Prévia da câmera para localizar código de barras" />
    <p role="status">{ready ? "Aponte o código para a câmera. A leitura não registra uma movimentação." : "Aguardando autorização e abertura da câmera…"}</p>
    <button type="button" className="button-secondary" onClick={() => onClose("Leitura por câmera encerrada.")}>Desligar câmera</button>
  </div>;
}
