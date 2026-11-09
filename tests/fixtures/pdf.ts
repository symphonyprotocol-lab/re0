/**
 * Minimal PDF writers for tests. `makePdf` writes one Helvetica page per
 * entry, one line per string (ASCII): a text layer the local parser reads.
 * `buildPdf` takes raw content streams, so a test can draw what it needs:
 * text at a size and place, an image XObject with no text (a scanned page),
 * text whose ToUnicode map points into the private-use area (garbled), or
 * a CJK font that needs pdf.js's predefined CMaps (which fails to load).
 */
const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 842;

/** Fonts and image every page can use: F1 Helvetica, F2 garbled Helvetica, F3 CJK, Im1 a 2x2 image. */
const RESOURCES = '<< /Font << /F1 3 0 R /F2 4 0 R /F3 6 0 R >> /XObject << /Im1 9 0 R >> >>';
const PUA_CMAP = [
  '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
  '/CMapName /Garbled def 1 begincodespacerange <00> <FF> endcodespacerange',
  '1 beginbfrange <20> <7E> <E000> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end',
].join('\n');
const PIXELS = 'FF000000FF000000FFFFFFFF';
const SHARED = [
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 5 0 R >>',
  `<< /Length ${PUA_CMAP.length} >>\nstream\n${PUA_CMAP}\nendstream`,
  '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [7 0 R] >>',
  '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 8 0 R >>',
  '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >>',
  `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${PIXELS.length + 1} >>\nstream\n${PIXELS}>\nendstream`,
];

/** A PDF string body; `•` becomes its WinAnsi byte, everything else must be ASCII. */
const escape = (text: string): string => text.replace(/[\\()]/g, (c) => `\\${c}`).replace(/•/g, '\\225');

/** Content-stream snippets for `buildPdf`. */
export const draw = {
  /** One line of Helvetica (`F1`), or garbled Helvetica (`F2`), at a baseline. */
  text: (text: string, { x = 56, y, size = 11, font = 'F1' }: { x?: number; y: number; size?: number; font?: 'F1' | 'F2' }) =>
    `BT /${font} ${size} Tf ${x} ${y} Td (${escape(text)}) Tj ET`,
  /** Two Chinese characters in a font that needs a predefined CMap. */
  cjk: (y: number) => `BT /F3 14 Tf 56 ${y} Td <4E2D6587> Tj ET`,
  /** The image, scaled over most of the page. */
  image: () => `q 480 0 0 680 66 80 cm /Im1 Do Q`,
};

/** A PDF with one page per content stream, every page sharing `RESOURCES`. */
export function buildPdf(streams: string[]): Uint8Array {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  SHARED.forEach((body, index) => { objects[index + 3] = body; });
  const pageIds: number[] = [];
  let next = SHARED.length + 3;
  for (const stream of streams) {
    const contentId = next++;
    const pageId = next++;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources ${RESOURCES} /Contents ${contentId} 0 R >>`;
    pageIds.push(pageId);
  }
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** One 11pt Helvetica line per string, 14pt apart from the top; an empty string leaves a blank line. */
const linesStream = (lines: string[]): string => `BT /F1 11 Tf 14 TL 56 780 Td ${lines.map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET`;

/** One page per entry, drawn by `linesStream`. */
export function makePdf(pages: string[][]): Uint8Array {
  return buildPdf(pages.map(linesStream));
}

/** Thirty pages about a fictional product, each with one fact only that page states. */
export function handbookPages(): string[][] {
  const topics = [
    'Onboarding', 'Billing', 'Refunds', 'Security', 'Exports', 'Teams', 'Roles', 'Integrations', 'Webhooks', 'Limits',
    'Search', 'Backups', 'Retention', 'Privacy', 'Support', 'Status page', 'Releases', 'Mobile app', 'Offline mode', 'Accessibility',
    'Localization', 'Audit log', 'Single sign-on', 'API keys', 'Rate limits', 'Storage', 'Notifications', 'Templates', 'Archiving', 'Glossary',
  ];
  return topics.map((topic, index) => [
    `Northwind Handbook - Chapter ${index + 1}: ${topic}`,
    '',
    `This chapter explains how ${topic.toLowerCase()} works in the Northwind workspace.`,
    `Key fact ${index + 1}: the ${topic.toLowerCase()} setting is managed by the workspace owner,`,
    `and changes take effect within ${index + 2} minutes for every member.`,
    index === 2 ? 'Refunds are issued to the original payment method within 14 days of the request.' : `The ${topic.toLowerCase()} policy was last reviewed in review cycle ${index + 7}.`,
    'Members can find the current configuration under Settings in the workspace sidebar.',
    'When in doubt, contact the workspace owner before changing anything shared.',
    ...Array.from({ length: 2 }, (_, line) => `Detail ${line + 1} about ${topic.toLowerCase()}: keep records tidy and consistent across teams.`),
  ]);
}

/** The handbook with its first page scanned: an image and no text, so the file goes to Firecrawl. */
export function scannedHandbookPdf(): Uint8Array {
  return buildPdf([draw.image(), ...handbookPages().slice(1).map(linesStream)]);
}
