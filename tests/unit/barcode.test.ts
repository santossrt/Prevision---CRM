import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StockProductDTO } from "../../src/lib/stock/types.ts";
import type { Principal } from "../../src/server/auth/identity.ts";
import { findProductByBarcode, parseBarcodeQuery } from "../../src/server/stock/barcode.ts";
import { cameraErrorMessage, releaseCamera, supportedBarcodeFormats } from "../../src/components/barcode/camera-support.ts";

const state = vi.hoisted(() => ({ lookup: vi.fn(), stock: vi.fn(), identity: vi.fn() }));
vi.mock("../../src/server/database/client.ts", () => ({ getDatabase: () => ({ product: { findUnique: state.lookup } }) }));
vi.mock("../../src/server/database/identity.ts", () => ({ verifyDatabaseIdentity: state.identity }));
vi.mock("../../src/server/stock/service.ts", () => ({ getStockProduct: state.stock }));

const productId = "00000000-0000-4000-8000-000000000001";
const actor = { id: "00000000-0000-4000-8000-000000000002", permissions: ["stock.read"] } as Principal;
const product: StockProductDTO = {
  id: productId, name: "Produto", sku: "ABC", barcode: "00000123", isActive: true, unitOfMeasure: "UN",
  category: { id: productId, name: "Categoria", isActive: true }, defaultSupplierId: null,
  quantity: "5.0000", version: 1, minimumStock: "2.0000", acquisitionCost: "1.0000", salePrice: "2.0000",
  stockStatus: "normal", estimatedCost: "5.00", potentialSale: "10.00", estimatedMargin: "5.00"
};

beforeEach(() => {
  state.lookup.mockReset().mockResolvedValue({ id: productId });
  state.stock.mockReset().mockResolvedValue({ ...product });
  state.identity.mockReset().mockResolvedValue(undefined);
});

describe("consulta exata por código de barras", () => {
  it("preserva os zeros iniciais e remove apenas espaços externos", () => {
    expect(parseBarcodeQuery(new URLSearchParams({ code: " 00000123 " }))).toBe("00000123");
  });
  it("preserva caracteres e maiúsculas do código, sem interpretar números", () => {
    expect(parseBarcodeQuery(new URLSearchParams({ code: "aB-00123" }))).toBe("aB-00123");
    expect(parseBarcodeQuery(new URLSearchParams({ code: "123456789012345678901234567890" }))).toBe("123456789012345678901234567890");
  });
  it("aceita o limite de 128 caracteres", () => {
    expect(parseBarcodeQuery(new URLSearchParams({ code: "A".repeat(128) }))).toHaveLength(128);
  });
  it.each(["", " ", "00 123", "00\t123", "00\n123", "\n00123", "00123\r", "00\u0000123", "00123\u007f", "A".repeat(129)])("recusa código inválido sem consultar o banco: %j", async (code) => {
    await expect(findProductByBarcode(actor, new URLSearchParams({ code }))).rejects.toMatchObject({ code: "VALIDATION" });
    expect(state.lookup).not.toHaveBeenCalled();
  });
  it.each(["", "code=001&code=002", "code=&code=001", "code=001&code=", "code=001&search=x", "search=001"]) ("recusa filtros ausentes, extras ou repetidos: %s", (query) => {
    expect(() => parseBarcodeQuery(new URLSearchParams(query))).toThrow();
  });
  it("consulta igualdade exata, não pesquisa parcial nem SKU", async () => {
    const result = await findProductByBarcode(actor, new URLSearchParams({ code: product.barcode! }));
    expect(state.lookup).toHaveBeenCalledExactlyOnceWith({ where: { barcode: "00000123" }, select: { id: true } });
    expect(state.stock).toHaveBeenCalledExactlyOnceWith(actor, productId);
    expect(result).toEqual(product);
    expect(state.identity).toHaveBeenCalledOnce();
  });
  it("recusa quem não tem stock.read antes de consultar identidade ou produto", async () => {
    await expect(findProductByBarcode({ ...actor, permissions: [] }, new URLSearchParams({ code: "00000123" }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.lookup).not.toHaveBeenCalled();
    expect(state.identity).not.toHaveBeenCalled();
  });
  it("informa código não cadastrado e não busca outro código como alternativa", async () => {
    state.lookup.mockResolvedValue(null);
    await expect(findProductByBarcode(actor, new URLSearchParams({ code: "123" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state.lookup).toHaveBeenCalledOnce();
    expect(state.stock).not.toHaveBeenCalled();
  });
  it("retorna o estado inativo para apresentação, preservando saldo e identidade", async () => {
    state.stock.mockResolvedValue({ ...product, isActive: false });
    expect(await findProductByBarcode(actor, new URLSearchParams({ code: product.barcode! }))).toMatchObject({ id: productId, isActive: false, quantity: "5.0000" });
  });
  it("não retorna outro código quando o cadastro muda durante a consulta", async () => {
    state.stock.mockResolvedValue({ ...product, barcode: "DIFFERENT" });
    await expect(findProductByBarcode(actor, new URLSearchParams({ code: product.barcode! }))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("ciclo e compatibilidade da câmera", () => {
  it("limita o detector aos formatos de barras realmente suportados", () => {
    expect(supportedBarcodeFormats(["unknown", "code_128", "qr_code", "ean_13"])).toEqual(["ean_13", "code_128"]);
    expect(supportedBarcodeFormats(["qr_code"])).toEqual([]);
  });
  it("encerra todas as faixas, pausa o vídeo e libera srcObject", () => {
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    const stream = { getTracks: () => tracks } as unknown as Pick<MediaStream, "getTracks">;
    const video = { pause: vi.fn(), srcObject: {} as MediaStream | null };
    releaseCamera(stream, video);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledOnce();
    expect(video.pause).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
  });
  it("permite encerrar uma solicitação cancelada antes de haver vídeo", () => {
    expect(() => releaseCamera(null, null)).not.toThrow();
    const stop = vi.fn();
    releaseCamera({ getTracks: () => [{ stop }] } as unknown as Pick<MediaStream, "getTracks">, null);
    expect(stop).toHaveBeenCalledOnce();
  });
  it("explica recusa de permissão sem divulgar mensagens do navegador", () => {
    const failure = new DOMException("identificador privado da câmera", "NotAllowedError");
    expect(cameraErrorMessage(failure)).toContain("não foi autorizada");
    expect(cameraErrorMessage(failure)).not.toContain("identificador privado");
    expect(cameraErrorMessage(new Error("outro detalhe privado"))).not.toContain("outro detalhe privado");
  });
});
