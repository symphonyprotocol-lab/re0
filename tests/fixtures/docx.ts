/**
 * Word documents built in code: a .docx is a zip of XML parts, written here
 * uncompressed (stored entries), with just the parts mammoth reads: the
 * document, its styles (heading names) and numbering (bullets). `deflatedZip`
 * builds a zip bomb.
 */
import { Readable } from 'node:stream';
import { crc32, createDeflateRaw } from 'node:zlib';

interface ZipEntry {
  name: string;
  /** The stored bytes: the content itself, or its raw deflate stream. */
  data: Uint8Array;
  deflated: boolean;
  /** What the headers declare; a zip bomb may lie about it. */
  size: number;
  crc: number;
}

function zip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data, deflated, size, crc } of entries) {
    const path = encoder.encode(name);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(8, deflated ? 8 : 0, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, size, true);
    header.setUint16(26, path.length, true);
    local.push(new Uint8Array(header.buffer), path, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, deflated ? 8 : 0, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, path.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), path);
    offset += 30 + path.length + data.length;
  }
  const directorySize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A zip archive of `files`, every entry stored without compression. */
export function makeZip(files: Record<string, string>): Uint8Array {
  return zip(Object.entries(files).map(([name, content]) => {
    const data = new TextEncoder().encode(content);
    return { name, data, deflated: false, size: data.length, crc: crc32(data) };
  }));
}

/**
 * A zip bomb: one entry of `bytes` zeros, deflated to a sliver, whose headers
 * claim it inflates to 1 KB. Built as a stream, so the zeros never sit in memory.
 */
export async function deflatedZip(name: string, bytes: number): Promise<Uint8Array> {
  const zeros = Buffer.alloc(1024 * 1024);
  const chunks: Buffer[] = [];
  const source = Readable.from((function* () {
    for (let left = bytes; left > 0; left -= zeros.length) yield left >= zeros.length ? zeros : zeros.subarray(0, left);
  })());
  for await (const chunk of source.pipe(createDeflateRaw({ level: 9 }))) chunks.push(chunk as Buffer);
  return zip([{ name, data: new Uint8Array(Buffer.concat(chunks)), deflated: true, size: 1024, crc: 0 }]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = (text: string): string => `<w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r>`;

/** Body elements for `makeDocx`. */
export const word = {
  heading: (level: 1 | 2, text: string) => `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>${run(text)}</w:p>`,
  paragraph: (text: string) => `<w:p>${run(text)}</w:p>`,
  bullet: (text: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(text)}</w:p>`,
  /** A table without a marked header row, as Word writes most tables. */
  table: (rows: string[][]) => `<w:tbl>${rows.map((cells) => `<w:tr>${cells.map((cell) => `<w:tc><w:p>${run(cell)}</w:p></w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`,
};

/** A .docx whose body is `elements` (see `word`). */
export function makeDocx(elements: string[]): Uint8Array {
  const relationship = (id: string, type: string, target: string) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationship('rId1', 'officeDocument', 'word/document.xml')}</Relationships>`,
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + `${relationship('rId1', 'styles', 'styles.xml')}${relationship('rId2', 'numbering', 'numbering.xml')}</Relationships>`,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>`
      + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>',
    'word/numbering.xml': `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}>`
      + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>'
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${elements.join('')}</w:body></w:document>`,
  });
}
