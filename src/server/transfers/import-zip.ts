import { crc32 } from "node:zlib";
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { ApplicationError } from "../errors/application-error.ts";

const invalid = () => new ApplicationError("VALIDATION", "O Excel contém uma estrutura inválida ou ultrapassa os limites de segurança. Utilize o modelo disponibilizado.");

function cellReference(value: string): { row: number; column: number } | null {
  const match = /^([A-Z]{1,2})([1-9]\d{0,3})$/u.exec(value);
  if (!match) return null;
  const row = Number(match[2]);
  const column = [...match[1]].reduce((total, digit) => total * 26 + digit.charCodeAt(0) - 64, 0);
  return row <= 5000 && column <= 32 ? { row, column } : null;
}

function rangeReference(value: string): boolean {
  const parts = value.split(":");
  if (parts.length > 2) return false;
  const first = cellReference(parts[0]); const last = cellReference(parts[1] ?? parts[0]);
  return !!first && !!last && first.row <= last.row && first.column <= last.column;
}

/** Inspect complete attribute values, rather than only references that already
 * look valid. ExcelJS uses parseInt for rows, so e.g. +999999999 must never reach
 * its loader. Comments, CDATA and quoted text are not worksheet attributes.
 *
 * Advance one cursor through tags and attribute values. A global regex can
 * retry an unterminated CDATA/comment/quoted tag at every later '<', making
 * rejection quadratic even when the ZIP and XML byte limits are respected. */
function validWorksheetReferences(xml: string): boolean {
  const nameStart = (code: number) => code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122;
  const namePart = (code: number) => nameStart(code) || code >= 48 && code <= 57 || code === 58 || code === 46 || code === 45;
  const whitespace = (code: number) => code === 32 || code === 9 || code === 10 || code === 13;
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) return true;
    let delimiter: string | undefined; let contentStart = start;
    if (xml.startsWith("<!--", start)) { delimiter = "-->"; contentStart += 4; }
    else if (xml.startsWith("<![CDATA[", start)) { delimiter = "]]>"; contentStart += 9; }
    else if (xml.startsWith("<?", start)) { delimiter = "?>"; contentStart += 2; }
    if (delimiter) {
      const end = xml.indexOf(delimiter, contentStart);
      if (end < 0) return false;
      cursor = end + delimiter.length;
      continue;
    }

    cursor = start + 1;
    const closing = xml[cursor] === "/";
    if (closing) cursor++;
    if (!nameStart(xml.charCodeAt(cursor))) return false;
    const nameOffset = cursor++;
    while (namePart(xml.charCodeAt(cursor))) cursor++;
    const name = xml.slice(nameOffset, cursor);
    const tag = name.slice(name.lastIndexOf(":") + 1);
    const names = new Set<string>();
    if (closing) {
      while (whitespace(xml.charCodeAt(cursor))) cursor++;
      if (xml[cursor++] !== ">") return false;
      continue;
    }

    while (true) {
      const beforeSpace = cursor;
      while (whitespace(xml.charCodeAt(cursor))) cursor++;
      if (xml[cursor] === ">") { cursor++; break; }
      if (xml[cursor] === "/" && xml[cursor + 1] === ">") { cursor += 2; break; }
      if (cursor === beforeSpace || !nameStart(xml.charCodeAt(cursor))) return false;
      const attributeOffset = cursor++;
      while (namePart(xml.charCodeAt(cursor))) cursor++;
      const attributeName = xml.slice(attributeOffset, cursor);
      if (names.has(attributeName)) return false;
      names.add(attributeName);
      while (whitespace(xml.charCodeAt(cursor))) cursor++;
      if (xml[cursor++] !== "=") return false;
      while (whitespace(xml.charCodeAt(cursor))) cursor++;
      const quote = xml[cursor++];
      if (quote !== '"' && quote !== "'") return false;
      const valueOffset = cursor; const end = xml.indexOf(quote, cursor);
      if (end < 0) return false;
      // Literal '<' is not legal in an XML attribute. Check only this value,
      // rather than searching the remainder of the document per attribute.
      for (; cursor < end; cursor++) if (xml[cursor] === "<") return false;
      cursor = end + 1;
      if (attributeName === "r") {
        const value = xml.slice(valueOffset, end);
        if (tag === "row") {
          if (!/^[1-9]\d{0,3}$/u.test(value) || Number(value) > 5000) return false;
        } else if (!cellReference(value)) return false;
      } else if (attributeName === "ref" && (end - valueOffset > 13 || !rangeReference(xml.slice(valueOffset, end)))) return false;
    }
    if ((tag === "row" || tag === "c") && !names.has("r")) return false;
  }
  return true;
}

/** Repack only validated entries so another ZIP reader cannot interpret a
 * conflicting local header, encrypted part or mismatched size differently. */
function repack(entries: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8"); const checksum = crc32(entry.data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(entry.data.length, 18); header.writeUInt32LE(entry.data.length, 22); header.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(0x0800, 8); index.writeUInt16LE(33, 14);
    index.writeUInt32LE(checksum, 16); index.writeUInt32LE(entry.data.length, 20); index.writeUInt32LE(entry.data.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    local.push(header, name, entry.data); central.push(index, name); offset += header.length + name.length + entry.data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function validatedWorkbookZip(buffer: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let zip: ZipFile | undefined; let failed = false; let total = 0; let entriesSeen = 0;
    const names = new Set<string>(); const entries: { name: string; data: Buffer }[] = [];
    const fail = () => { if (failed) return; failed = true; zip?.close(); reject(invalid()); };
    fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true, strictFileNames: true }, (error, archive) => {
      if (error || !archive) { fail(); return; } zip = archive;
      archive.on("error", fail);
      archive.on("end", () => {
        if (failed) return;
        if (!names.has("[Content_Types].xml") || !names.has("xl/workbook.xml")) { fail(); return; }
        resolve(repack(entries));
      });
      archive.on("entry", (entry: Entry) => {
        if (failed) return;
        const name = entry.fileName;
        if (++entriesSeen > 1000 || entry.isEncrypted() || names.has(name) || /(^\/|\\|(^|\/)\.\.(\/|$)|\0)/u.test(name)
          || /vbaProject|externalLinks|\.exe$|\.bin$/iu.test(name) || ![0, 8].includes(entry.compressionMethod)
          || entry.uncompressedSize > 5 * 1024 * 1024 || total + entry.uncompressedSize > 20 * 1024 * 1024) { fail(); return; }
        names.add(name);
        if (name.endsWith("/")) { archive.readEntry(); return; }
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(); return; }
          const chunks: Buffer[] = []; let size = 0;
          stream.on("error", fail);
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length; total += chunk.length;
            if (size > 5 * 1024 * 1024 || total > 20 * 1024 * 1024) { stream.destroy(); fail(); return; }
            chunks.push(chunk);
          });
          stream.on("end", () => {
            if (failed) return;
            const data = Buffer.concat(chunks);
            if (size !== entry.uncompressedSize || crc32(data) !== entry.crc32) { fail(); return; }
            if (/\.(?:xml|rels)$/iu.test(name)) {
              let xml: string;
              try { xml = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { fail(); return; }
              if (/<!\s*(?:DOCTYPE|ENTITY)|TargetMode\s*=\s*["']External["']|macroEnabled/iu.test(xml)) { fail(); return; }
              if (/^xl\/worksheets\/.*\.xml$/u.test(name) && !validWorksheetReferences(xml)) { fail(); return; }
            }
            entries.push({ name, data }); archive.readEntry();
          });
        });
      });
      archive.readEntry();
    });
  });
}
