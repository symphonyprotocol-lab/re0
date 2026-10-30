/**
 * Uploaded PDFs, read back from object storage and turned into text.
 *
 * The other connectors fetch from somewhere; this one has nothing to fetch.
 * The wizard put the files in the bucket before the asset existed
 * (architecture.md 7), and the source row's config says where. So the
 * "snapshot" is: read each key, extract its text, and hand the pipeline a
 * file per PDF -- named as the operator named it, so that a citation reads
 * `handbook.pdf` and not an object key.
 *
 * Text extraction is pdf.js, through unpdf's serverless build: no worker
 * thread, no canvas, no native module. Pages are joined with a blank line;
 * page boundaries are not headings, and pretending they are would cut
 * paragraphs mid-sentence at every page break.
 *
 * A PDF with no text layer -- a scan -- yields nothing that way. When an OCR
 * provider is configured (`ocr.ts`) and at most half of the pages carried
 * text, the whole file goes to the provider and its reading is used
 * instead. Whole file rather than the blank pages alone, because a scanned
 * report with a typed cover sheet reads as one document, not as a cover
 * sheet followed by an OCR transcript that starts on page two.
 */
import { extractText, getDocumentProxy } from 'unpdf';
import { EMPTY_SOURCE_CONFIG, IngestionFailure } from '@/lib/domain/ingestion';
import { uploadedFilesOf, type UploadedFile, PLATFORM_UPLOAD_OWNER } from '@/lib/domain/asset';
import type { ObjectStore } from '@/lib/infrastructure/objects/store';
import { pdfOcr, type PdfOcr } from './ocr';
import type { FetchedFile, SourceSnapshot } from './types';

/** Reads run this many at a time; the store is one request per key. */
const READ_CONCURRENCY = 4;

export async function fetchPdfSnapshot(input: {
  config: Record<string, unknown>;
  store: Pick<ObjectStore, 'get'>;
  /** Omitted means the configured provider; null means none. */
  ocr?: PdfOcr | null;
}): Promise<SourceSnapshot> {
  const ocr = input.ocr === undefined ? pdfOcr() : input.ocr;
  const uploads = uploadedFilesOf(input.config);
  if (uploads.length === 0) {
    throw new IngestionFailure('source_empty', 'fetch-snapshot', 'the source lists no files');
  }

  const files: FetchedFile[] = [];
  for (let at = 0; at < uploads.length; at += READ_CONCURRENCY) {
    const batch = await Promise.all(
      uploads.slice(at, at + READ_CONCURRENCY).map((upload) => readOne(upload, input.store, ocr)),
    );
    files.push(...batch);
  }

  return {
    files,
    config: EMPTY_SOURCE_CONFIG,
    revision: null,
    lastModifiedAt: null,
    hasLicense: false,
    stale: false,
  };
}

async function readOne(
  upload: UploadedFile,
  store: Pick<ObjectStore, 'get'>,
  ocr: PdfOcr | null,
): Promise<FetchedFile> {
  let bytes: Uint8Array | null;
  try {
    bytes = await store.get(upload.key);
  } catch (error) {
    throw new IngestionFailure(
      'storage_unavailable',
      'fetch-snapshot',
      `could not read ${upload.name}: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
  if (!bytes) {
    throw new IngestionFailure(
      'source_unreachable',
      'fetch-snapshot',
      `${upload.name} is no longer in storage`,
    );
  }

  return {
    path: upload.name,
    /* Served by the dashboard for the owning workspace, or by the public
       files route for a platform asset's upload; the asset id is not
       known here, and either route resolves the file by its own id. */
    url: upload.key.startsWith(`uploads/${PLATFORM_UPLOAD_OWNER}/`)
      ? `/files/${upload.id}`
      : `/dashboard/files/${upload.id}`,
    content: await pdfText(bytes, upload.name, ocr),
    format: 'text',
  };
}

/**
 * The text of a PDF, one page after another. A PDF with no extractable
 * text -- a scan, an image-only export -- goes to the OCR provider when one
 * is configured, and otherwise comes back empty, which the build's parse
 * step reports as nothing parsed rather than this connector inventing a
 * page.
 */
export async function pdfText(bytes: Uint8Array, name: string, ocr: PdfOcr | null = null): Promise<string> {
  let pages: string[];
  try {
    /* pdf.js takes ownership of the buffer it is given and leaves it
       detached; the OCR call below needs the bytes intact, so it gets a copy. */
    const pdf = await getDocumentProxy(bytes.slice());
    const { text } = await extractText(pdf, { mergePages: false });
    pages = (Array.isArray(text) ? text : [text]).map((page) =>
      page.replace(/[ \t]+\n/g, '\n').trim(),
    );
  } catch (error) {
    throw new IngestionFailure(
      'parse_failed',
      'discover-parse',
      `${name} is not a readable PDF: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
  const extracted = pages.filter((page) => page.length > 0).join('\n\n');

  if (ocr && needsOcr(pages)) {
    const recognised = await ocr.recognize({ bytes, name });
    /* A provider that read nothing from a blank scan has not made the
       extracted text (if any) worse. */
    if (recognised.length > 0) return recognised;
  }
  return extracted;
}

/** True when at most half of the pages carried a text layer. */
export function needsOcr(pages: string[]): boolean {
  const withText = pages.filter((page) => page.length > 0).length;
  return withText * 2 <= pages.length;
}
