/**
 * OCR fallback for uploaded PDFs that carry no text layer (rebuild-proposal.md 2.1).
 *
 * A scan, a fax, a photographed contract exported as PDF: pdf.js finds no
 * text in any of them, and without help the build reports nothing parsed.
 * With an OCR provider configured the PDF connector hands the bytes to the
 * provider and indexes what it reads back. It is a fallback, never the first
 * attempt: text extraction is local and free, and every page recognised
 * elsewhere is a page whose content a vendor saw.
 *
 * Provider and credential are environment:
 *
 *   OCR_PROVIDER           ocrspace; unset means scanned PDFs stay unread
 *   OCR_PROVIDER_API_KEY   required for ocr.space
 *   OCR_PROVIDER_BASE_URL  unset means the vendor's public API; PRO plans
 *                          get a regional endpoint, and that goes here
 *   OCR_PROVIDER_LANGUAGE  optional, passed through to the provider; for
 *                          ocr.space a three-letter code such as `chs`
 *
 * One provider today, but the seam is the point: the connector only knows
 * `PdfOcr`, so a second vendor is one more `case` below and nothing above
 * `lib/infra` changes.
 *
 * The bytes are sent as a multipart upload rather than a URL to a signed
 * object, so the store never has to be reachable from the vendor and no
 * signed URL leaves our process. Page limits and size limits are the plan's
 * business (ocr.space: 1 MB and 3 pages free, 100 MB and 999 pages on the
 * PDF plan); the adapter surfaces the vendor's refusal as `parse_failed`
 * rather than second-guessing it.
 */
import { ProcessingFailure } from '@/lib/infra/connectors/failure';

export type OcrProviderName = 'ocrspace';

export interface PdfOcr {
  readonly name: OcrProviderName;
  /**
   * The text of every page, one entry per page; a page the provider could
   * not read is an empty string. Throws
   * `ProcessingFailure('parse_failed')` when the provider refused or failed.
   */
  recognize(pdf: { bytes: Uint8Array; name: string }): Promise<string[]>;
}

const DEFAULT_BASE_URL: Record<OcrProviderName, string> = {
  ocrspace: 'https://api.ocr.space',
};

/** Recognition of a long PDF is slow; the plain-fetch timeout is far too short. */
const TIMEOUT_MS = 120_000;

/** A vendor's error string is bounded vocabulary, but bound its length too. */
const MAX_DETAIL = 200;

function providerName(): OcrProviderName | null {
  const name = process.env.OCR_PROVIDER?.trim().toLowerCase();
  return name === 'ocrspace' ? name : null;
}

export function isOcrConfigured(): boolean {
  return pdfOcr() !== null;
}

interface Endpoint {
  baseUrl: string;
  apiKey: string;
  language: string | null;
}

/** The configured OCR provider, or null when scanned PDFs are left unread. */
export function pdfOcr(): PdfOcr | null {
  const name = providerName();
  if (!name) return null;
  const apiKey = process.env.OCR_PROVIDER_API_KEY?.trim() || null;
  /* Every supported vendor refuses anonymous calls; a missing key is the
     fallback being off, not a call that will fail on every scan. */
  if (!apiKey) return null;
  const custom = process.env.OCR_PROVIDER_BASE_URL?.trim() || null;
  const endpoint: Endpoint = {
    baseUrl: (custom ?? DEFAULT_BASE_URL[name]).replace(/\/+$/, ''),
    apiKey,
    language: process.env.OCR_PROVIDER_LANGUAGE?.trim() || null,
  };
  return ocrSpace(endpoint);
}

function unrecognised(name: OcrProviderName, file: string, detail: string): ProcessingFailure {
  return new ProcessingFailure('parse_failed', `${name} could not read ${file}: ${detail.slice(0, MAX_DETAIL)}`);
}

function detailOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim());
    return typeof first === 'string' ? first.trim() : null;
  }
  return null;
}

/* --------------------------------------------------------------- ocr.space */

/**
 * https://ocr.space/ocrapi -- POST /parse/image, one multipart file.
 *
 * The answer lists one `ParsedResults` entry per page. `OCRExitCode` 1 is
 * every page read, 2 is some pages read (kept: half a scan beats none), 3 and
 * 4 are nothing read. `IsErroredOnProcessing` covers the refusals -- a file
 * over the plan's size, more pages than the plan allows, a bad key.
 */
interface OcrSpaceAnswer {
  ParsedResults?: { ParsedText?: unknown; FileParseExitCode?: unknown; ErrorMessage?: unknown }[];
  OCRExitCode?: unknown;
  IsErroredOnProcessing?: unknown;
  ErrorMessage?: unknown;
  ErrorDetails?: unknown;
}

function ocrSpace(endpoint: Endpoint): PdfOcr {
  return {
    name: 'ocrspace',
    async recognize({ bytes, name }) {
      const form = new FormData();
      form.set('file', new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }), name);
      form.set('filetype', 'PDF');
      form.set('isOverlayRequired', 'false');
      form.set('detectOrientation', 'true');
      /* Scans are often 150 dpi or less; upscaling is what makes them legible. */
      form.set('scale', 'true');
      if (endpoint.language) form.set('language', endpoint.language);

      let response: Response;
      try {
        response = await fetch(`${endpoint.baseUrl}/parse/image`, {
          method: 'POST',
          headers: { apikey: endpoint.apiKey },
          body: form,
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: 'no-store',
        });
      } catch (error) {
        throw unrecognised('ocrspace', name, error instanceof Error ? error.message : 'request failed');
      }
      if (!response.ok) throw unrecognised('ocrspace', name, `HTTP ${response.status}`);

      let answer: OcrSpaceAnswer;
      try {
        answer = (await response.json()) as OcrSpaceAnswer;
      } catch {
        throw unrecognised('ocrspace', name, 'the response was not JSON');
      }

      if (answer.IsErroredOnProcessing === true) {
        throw unrecognised(
          'ocrspace',
          name,
          detailOf(answer.ErrorMessage) ?? detailOf(answer.ErrorDetails) ?? 'processing error',
        );
      }
      const exit = Number(answer.OCRExitCode);
      if (exit !== 1 && exit !== 2) {
        throw unrecognised('ocrspace', name, `exit code ${String(answer.OCRExitCode)}`);
      }

      /* One entry per page, unreadable ones empty, so page numbers stay aligned with the PDF. */
      return (answer.ParsedResults ?? []).map((page) =>
        Number(page.FileParseExitCode) === 1 && typeof page.ParsedText === 'string'
          ? page.ParsedText.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim()
          : '',
      );
    },
  };
}
