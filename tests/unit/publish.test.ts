/**
 * The checks a file passes before it is published as an original
 * (lib/domain/publish.ts, docs/design/agent-workspace-p4.md §2.4): the type
 * allowlist, PDF and Office active content (also hidden in compressed
 * streams and behind name escapes), text, previews, titles and the download's
 * file name.
 */
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { attachmentDisposition, cleanTitle, officeVerdict, pdfActiveContent, previewOf, publishTypeOf, strictText } from '@/lib/domain/publish';

const pdf = (body: string) => new TextEncoder().encode(`%PDF-1.7\n${body}\n%%EOF\n`);

async function office(parts: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  for (const [name, text] of Object.entries(parts)) zip.file(name, text);
  return zip.generateAsync({ type: 'uint8array' });
}

describe('publishTypeOf', () => {
  it('allows text, data, PDF, macro-free Office and four image types, by extension, in any case', () => {
    for (const [path, category] of [['/a.md', 'text'], ['/A.CSV', 'text'], ['/x.yaml', 'text'], ['/d.pdf', 'pdf'], ['/w.DOCX', 'office'], ['/s.xlsx', 'office'], ['/p.pptx', 'office'], ['/i.jpeg', 'image'], ['/i.webp', 'image']] as const) {
      expect(publishTypeOf(path)?.category).toBe(category);
    }
  });

  it('refuses what can run, render as a page or hide other files', () => {
    for (const path of ['/a.html', '/a.htm', '/a.svg', '/a.js', '/a.mjs', '/a.exe', '/a.msi', '/a.sh', '/a.ps1', '/a.bat', '/a.zip', '/a.tar.gz', '/a.docm', '/a.xlsm', '/a.mp4', '/a.mp3', '/a.py', '/noext', '/.env']) {
      expect(publishTypeOf(path), path).toBeNull();
    }
  });
});

describe('pdfActiveContent', () => {
  it('passes a plain PDF and refuses something that is not one', () => {
    expect(pdfActiveContent(pdf('1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj'), 1 << 20)).toBeNull();
    expect(pdfActiveContent(new TextEncoder().encode('MZ\u0090\u0000 not a pdf'), 1 << 20)).toBe('not_a_pdf');
  });

  it('finds scripts, launch actions, embedded files, rich media and XFA, also behind #xx escapes', () => {
    expect(pdfActiveContent(pdf('<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>'), 1 << 20)).toBe('javascript');
    expect(pdfActiveContent(pdf('<< /S /Launch /F (calc.exe) >>'), 1 << 20)).toBe('launch');
    expect(pdfActiveContent(pdf('<< /EmbeddedFiles << >> >>'), 1 << 20)).toBe('embeddedfiles');
    expect(pdfActiveContent(pdf('<< /RichMedia 1 0 R >>'), 1 << 20)).toBe('richmedia');
    expect(pdfActiveContent(pdf('<< /AcroForm << /XFA 5 0 R >> >>'), 1 << 20)).toBe('xfa');
    expect(pdfActiveContent(pdf('<< /S /J#61vaScript >>'), 1 << 20)).toBe('javascript');
  });

  it('looks inside Flate-compressed streams (object streams hide dictionaries), within a budget', () => {
    const hidden = deflateSync(Buffer.from('<< /Type /Action /S /JavaScript /JS (this.print()) >>'));
    const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n4 0 obj << /Type /ObjStm /Filter /FlateDecode >>\nstream\n'), hidden, Buffer.from('\nendstream\nendobj\n%%EOF\n')]);
    expect(pdfActiveContent(bytes, 1 << 20)).toBe('javascript');
    const harmless = deflateSync(Buffer.from('BT /F1 12 Tf (Hello) Tj ET'));
    const clean = Buffer.concat([Buffer.from('%PDF-1.7\n4 0 obj << /Filter /FlateDecode >>\nstream\r\n'), harmless, Buffer.from('\nendstream\nendobj\n%%EOF\n')]);
    expect(pdfActiveContent(clean, 1 << 20)).toBeNull();
    /* A stream larger than what is left of the budget cannot be told safe. */
    const big = deflateSync(Buffer.alloc(4096, 0x20));
    const heavy = Buffer.concat([Buffer.from('%PDF-1.7\nstream\n'), big, Buffer.from('\nendstream\n')]);
    expect(pdfActiveContent(heavy, 1024)).toBe('too_large_to_check');
  });
});

describe('officeVerdict', () => {
  it('passes a clean document and reads its text', async () => {
    const bytes = await office({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Quarterly &amp; plan</w:t></w:r></w:p></w:body></w:document>', 'word/_rels/document.xml.rels': '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/></Relationships>' });
    const verdict = await officeVerdict(bytes, 10_000);
    expect(verdict.active).toBeNull();
    expect(verdict.text).toContain('Quarterly & plan');
  });

  it('refuses macros, ActiveX, OLE objects and outside templates', async () => {
    expect((await officeVerdict(await office({ 'word/vbaProject.bin': 'x' }), 1000)).active).toBe('macros');
    expect((await officeVerdict(await office({ 'word/activeX/activeX1.xml': '<a/>' }), 1000)).active).toBe('activex');
    expect((await officeVerdict(await office({ 'word/embeddings/oleObject1.bin': 'x' }), 1000)).active).toBe('ole_object');
    const template = '<Relationships><Relationship Id="r9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://evil.example/t.dotm" TargetMode="External"/></Relationships>';
    expect((await officeVerdict(await office({ 'word/_rels/settings.xml.rels': template }), 1000)).active).toBe('external_reference');
    /* An outside hyperlink is fine: it fetches nothing on its own. */
    const link = '<Relationships><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>';
    expect((await officeVerdict(await office({ 'word/_rels/document.xml.rels': link }), 1000)).active).toBeNull();
  });

  it('refuses a macro-enabled content type, a ZIP that is not Office, and something that is not a ZIP', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types><Override ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>');
    expect((await officeVerdict(await zip.generateAsync({ type: 'uint8array' }), 1000)).active).toBe('macros');
    const plain = new JSZip();
    plain.file('readme.txt', 'hi');
    expect((await officeVerdict(await plain.generateAsync({ type: 'uint8array' }), 1000)).active).toBe('not_office');
    expect((await officeVerdict(new TextEncoder().encode('%PDF-1.4'), 1000)).active).toBe('not_a_zip');
  });
});

describe('text, previews, titles and names', () => {
  it('decodes strict UTF-8 only, without NUL', () => {
    expect(strictText(new TextEncoder().encode('héllo'))).toBe('héllo');
    expect(strictText(Uint8Array.from([0xff, 0xfe, 0x41]))).toBeNull();
    expect(strictText(Uint8Array.from([0x41, 0x00, 0x42]))).toBeNull();
  });

  it('cuts a preview to lines, then to bytes on a character boundary', () => {
    expect(previewOf('a\nb\nc', 2, 100)).toBe('a\nb');
    expect(previewOf('你好世界', 10, 7)).toBe('你好');
  });

  it('keeps a title to one plain line of at most `max` characters', () => {
    expect(cleanTitle('  Q4\n\treport  ', 80)).toBe('Q4 report');
    expect(cleanTitle('😀'.repeat(100), 80)).toHaveLength(160);
    expect(cleanTitle('   ', 80)).toBeNull();
    expect(cleanTitle(42, 80)).toBeNull();
  });

  it('names a download with an ASCII fallback and the encoded UTF-8 name', () => {
    expect(attachmentDisposition('报告 (final)!.pdf')).toBe(`attachment; filename="__ (final)!.pdf"; filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%28final%29%21.pdf`);
    expect(attachmentDisposition('a"b\\c.txt')).toBe(`attachment; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`);
  });
});
