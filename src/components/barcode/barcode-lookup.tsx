"use client";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import type { StockProductDTO } from "@/lib/stock/types";
import { CatalogRequestError, catalogError, catalogRequest, isCancelled } from "@/components/catalog/catalog-api";
import { decimal } from "@/components/stock/stock-format";
import { BarcodeCamera } from "./barcode-camera";
import styles from "./barcode.module.css";

export function BarcodeLookup({ onSelectProduct }: { onSelectProduct: (id: string) => void }) {
  const id = useId();
  const [code, setCode] = useState("");
  const [product, setProduct] = useState<StockProductDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const [camera, setCamera] = useState(false);
  const [cameraMessage, setCameraMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function lookup(raw = code) {
    setCamera(false);
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setError(""); setProduct(null); setNotFound(false);
    const barcode = raw.trim();
    if (!barcode || barcode.length > 128 || /[\u0000-\u001f\u007f]/u.test(raw) || /\s/u.test(barcode)) {
      setError("Informe um código de barras válido, com até 128 caracteres e sem espaços."); setBusy(false); return;
    }
    setCode(barcode); setBusy(true);
    try {
      const found = await catalogRequest<StockProductDTO>(`/api/stock/barcode?${new URLSearchParams({ code: barcode })}`, { signal: controller.signal });
      if (!controller.signal.aborted) setProduct(found);
    } catch (failure) {
      if (!controller.signal.aborted && !isCancelled(failure)) { setError(catalogError(failure)); setNotFound(failure instanceof CatalogRequestError && failure.status === 404); }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }

  return <div className={styles.lookup} role="group" aria-labelledby={`${id}-title`}>
    <div className={styles.heading}><strong id={`${id}-title`}>Localizar por código de barras</strong><span>Digite o código ou use um leitor USB neste campo e pressione Enter.</span></div>
    <div className={styles.search}><label className="sr-only" htmlFor={id}>Código de barras exato</label><input ref={inputRef} id={id} type="text" value={code} maxLength={128} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Código de barras, incluindo zeros iniciais" onChange={(event) => { request.current?.abort(); setBusy(false); setCode(event.target.value); setProduct(null); setError(""); setNotFound(false); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void lookup(); } }} /><button type="button" className="button-secondary" disabled={busy || !code.trim()} onClick={() => void lookup()}>{busy ? "Consultando…" : "Buscar código"}</button></div>
    {!camera && <button type="button" className="text-link" disabled={busy} onClick={() => { setCameraMessage(""); setCamera(true); }}>Ler com câmera</button>}
    {camera && <BarcodeCamera onCode={(value) => { setCamera(false); setCameraMessage("Código lido. Confira o produto antes de selecioná-lo."); setCode(value); void lookup(value); inputRef.current?.focus(); }} onClose={(message) => { setCamera(false); setCameraMessage(message ?? ""); inputRef.current?.focus(); }} />}
    {cameraMessage && <p className={styles.note} role="status">{cameraMessage}</p>}
    {busy && <p className={styles.note} role="status">Consultando o cadastro e o saldo do produto…</p>}
    {error && <div className="form-message form-error" role="alert"><p>{error}</p>{notFound && <p><Link className="text-link" href={`/produtos?${new URLSearchParams({ barcode: code })}`}>Conferir ou cadastrar em Produtos</Link></p>}</div>}
    {product && <div className={styles.result}><div><strong>{product.name}</strong><span>{product.sku} · Código: {product.barcode}</span><span>Saldo: {decimal(product.quantity)} {product.unitOfMeasure}</span></div>{product.isActive ? <button type="button" className="button-secondary" onClick={() => onSelectProduct(product.id)}>Usar este produto</button> : <p className="form-message form-error">Produto inativo. Ative o cadastro antes de registrar uma nova movimentação.</p>}</div>}
    <p className={styles.note}>A busca usa o código completo cadastrado e preserva zeros iniciais. A câmera depende do navegador e da sua autorização; a imagem é processada no dispositivo.</p>
  </div>;
}
