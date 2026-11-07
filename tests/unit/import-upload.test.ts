import { describe, expect, it } from "vitest";
import { readImportUpload } from "../../src/server/transfers/import-http.ts";

function upload(content: string | Uint8Array, name = "produtos.csv", extra = false) {
  const form = new FormData(); form.set("file", new Blob([typeof content === "string" ? content : new Uint8Array(content)]), name);
  if (extra) form.set("unrecognized", "private-input");
  return new Request("http://127.0.0.1:3000/api/transfers/imports/preview", { method: "POST", body: form });
}
describe("limites do recebimento multipart", () => {
  it("mantém o arquivo somente em memória e normaliza o nome de download", async () => {
    const file = await readImportUpload(upload("Nome;SKU;Categoria\nP;A;Casa", "pasta\\produtos.CSV"));
    expect(file.fileName).toBe("produtos.CSV"); expect(file.format).toBe("csv"); expect(file.buffer.toString()).toContain("P;A;Casa");
  });
  it.each(["arquivo.xls", "arquivo.xlsm", "arquivo.exe", "arquivo"])("rejeita extensão não suportada %s", async (name) => {
    await expect(readImportUpload(upload("not-a-workbook", name))).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("rejeita arquivo vazio, tamanho acima de2MiB e campos extras", async () => {
    await expect(readImportUpload(upload(""))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(readImportUpload(upload(new Uint8Array(2 * 1024 * 1024 + 1)))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(readImportUpload(upload("valid", "produtos.csv", true))).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("rejeita corpo grande pelo cabeçalho e pelo tamanho real independentemente do cabeçalho", async () => {
    const header = new Request("http://127.0.0.1:3000", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(3 * 1024 * 1024 + 1) }, body: "x" });
    await expect(readImportUpload(header)).rejects.toMatchObject({ code: "VALIDATION" });
    const actual = new Request("http://127.0.0.1:3000", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": "1" }, body: new Uint8Array(3 * 1024 * 1024 + 1) });
    await expect(readImportUpload(actual)).rejects.toMatchObject({ code: "VALIDATION" });
  });
  it("recusa JSON e multipart sem arquivo único", async () => {
    await expect(readImportUpload(new Request("http://127.0.0.1:3000", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))).rejects.toMatchObject({ code: "VALIDATION" });
    const form = new FormData(); form.append("file", "not-a-file");
    await expect(readImportUpload(new Request("http://127.0.0.1:3000", { method: "POST", body: form }))).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
