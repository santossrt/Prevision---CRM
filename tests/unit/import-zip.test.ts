import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { validatedWorkbookZip } from "../../src/server/transfers/import-zip.ts";

// Small stored ZIP fixtures let the preflight be exercised without handing
// adversarial row addresses to ExcelJS or allocating their requested ranges.
function archive(worksheet: string): Buffer {
  const entries = [
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ["xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'],
    ["xl/worksheets/sheet1.xml", worksheet]
  ];
  const local: Buffer[] = []; const directory: Buffer[] = []; let offset = 0;
  for (const [path, contents] of entries) {
    const name = Buffer.from(path); const data = Buffer.from(contents); const checksum = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6);
    index.writeUInt32LE(checksum, 16); index.writeUInt32LE(data.length, 20); index.writeUInt32LE(data.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    local.push(header, name, data); directory.push(index, name); offset += header.length + name.length + data.length;
  }
  const central = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

const worksheet = (contents: string) => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${contents}</worksheet>`;

describe("referências XML antes da leitura do Excel", () => {
  it("aceita os limites completos de linha e coluna e ignora texto em comentários e CDATA", async () => {
    const source = worksheet('<dimension ref="A1:AF5000"/><sheetData><row r="5000"><c r="AF5000" t="inlineStr"><is><t><![CDATA[<row r="+999999999"/>]]></t></is></c></row></sheetData><!-- <c r="AG999999999"/> -->');
    await expect(validatedWorkbookZip(archive(source))).resolves.toBeInstanceOf(Buffer);
  });

  it("aceita namespaces, instruções, aspas e espaços XML sem interpretar referências dentro do texto", async () => {
    const source = '<?xml version="1.0" encoding="UTF-8"?>' + worksheet(
      '<x:sheetData xmlns:x="urn:worksheet"><x:row\tr = \'1\'\r\n><x:c r="A1" t="inlineStr" data=\'r="AG999999999"\'><is><t>&lt;row r="+999999999"/&gt;</t></is></x:c></x:row></x:sheetData>' +
      '<!-- <row r="999999999"/> --><?preflight r="999999999"?>' +
      '<ignored><![CDATA[<c r="AG999999999"/>]]></ignored>'
    );
    await expect(validatedWorkbookZip(archive(source))).resolves.toBeInstanceOf(Buffer);
  });

  it.each([
    ['CDATA', '<![CDATA[', 32768],
    ['comentário', '<!--', 32768],
    ['instrução', '<?', 32768]
  ] as const)("recusa %s incompleto com muitos inícios sem procurar um token posterior", async (_label, marker, count) => {
    // A global lazy regex retried every marker and performed quadratic work.
    // These fixtures stay bounded; rejection must occur at the first token.
    await expect(validatedWorkbookZip(archive(worksheet(marker.repeat(count))))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it.each([
    `<${'a'.repeat(131072)}`,
    `<ignored ${'a'.repeat(131072)}="unterminated`,
    `<ignored value="${'<'.repeat(131072)}`,
    `<ignored value="${'a'.repeat(131072)}`,
    `<ignored ${' '.repeat(131072)}value=`,
    `<row r="${'9'.repeat(131072)}"/>`
  ])("recusa tags e atributos longos incompletos sem tentar separar o nome repetidamente", async (contents) => {
    await expect(validatedWorkbookZip(archive(worksheet(contents)))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("percorre muitos atributos válidos em sequência e mantém a regra de referências", async () => {
    const attributes = Array.from({ length: 8192 }, (_, index) => `data${index}="valor"`).join(" ");
    await expect(validatedWorkbookZip(archive(worksheet(`<ignored ${attributes}/><row r="1"><c r="AF5000"/></row>`)))).resolves.toBeInstanceOf(Buffer);
    await expect(validatedWorkbookZip(archive(worksheet(`<ignored ${attributes}/><row r="5001"/>`)))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it.each(["+999999999", " 999999999", "5001", "999999999x", "1e9", "0", "-1", "0001", "1.5", "&#49;", ""])("recusa a linha não canônica ou excessiva %s antes do loader", async (reference) => {
    await expect(validatedWorkbookZip(archive(worksheet(`<sheetData><row r='${reference}'><c r="A1"/></row></sheetData>`)))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it.each(["AF5001", "AG1", "a1", "A0", "A01", "A+999999999", "A999999999tail", "A1:B2", "$A$1", "A&#49;"])("recusa o endereço de célula inválido %s", async (reference) => {
    await expect(validatedWorkbookZip(archive(worksheet(`<sheetData><row r="1"><c r='${reference}'/></row></sheetData>`)))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it.each(["A5001:A1", "AG1:A1", "AF5000:AG5000", "A1:A5001", "B2:A1", "A1:B0", "A1:", "A1:A2:A3", "+A1", "&#65;1:A2"])("valida os dois extremos completos do intervalo %s", async (reference) => {
    await expect(validatedWorkbookZip(archive(worksheet(`<dimension ref='${reference}'/>`)))).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it.each([
    '<row r=999999999/>', '<row r="1" r="999999999"/>', '<row/>',
    '<row r="1"><c r="A1"r="AG1"/></row>', '<row r="1"><c/></row>', '<dimension ref="A1:AF5000/>',
    '<row r="1" data="<row/>"/>', '<row r="1" / >', '</row r="1">', '<row\u00a0r="1"/>'
  ])("recusa atributos incompletos, não delimitados ou duplicados: %s", async (contents) => {
    await expect(validatedWorkbookZip(archive(worksheet(`<sheetData>${contents}</sheetData>`)))).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
