/**
 * Identity verification, reviewed by hand (rebuild-proposal.md 2.3, 8.4 step
 * 6, prototype manual-kyc.js): what a submission must hold, who may submit,
 * when an administrator may approve, and when the images must go. No
 * database here; `lib/services/kyc.ts` applies these.
 *
 * A user's state is their newest record: none yet, `pending` (waiting for
 * review, read-only), `verified`, `rejected` (may submit again) or `reset`
 * (an administrator asked for re-verification; may submit again).
 */
import { KYC_DOCUMENT_KINDS, KYC_FILE_RETENTION_DAYS, KYC_IMAGE_TYPES, KYC_LIMITS, TAX_FORMS } from '@/lib/constants';
import type { KycStatus } from '@/db/schema';
import { charLength } from '@/lib/domain/roles';
import { validReportDate } from '@/lib/domain/statistics';

export type KycState = 'none' | KycStatus;
export type DocumentKind = (typeof KYC_DOCUMENT_KINDS)[number];
export type TaxForm = (typeof TAX_FORMS)[number];
export type KycSlot = 'document' | 'selfie';
export const KYC_SLOTS: readonly KycSlot[] = ['document', 'selfie'];

const DAY = 24 * 60 * 60 * 1000;

export function kycState(latest: { status: KycStatus } | null | undefined): KycState {
  return latest?.status ?? 'none';
}

/** A first submission, or again after a rejection or a re-verification request. */
export function canSubmitKyc(state: KycState): boolean {
  return state === 'none' || state === 'rejected' || state === 'reset';
}

export interface KycSubmission {
  legalName: string;
  country: string;
  documentKind: DocumentKind;
  documentLast4: string;
  documentExpires: string;
  taxForm: TaxForm;
  documentBlob: string;
  selfieBlob: string;
}

export type KycInputError = 'legal_name' | 'country' | 'document_kind' | 'last4' | 'expires' | 'tax_form' | 'declared' | 'consent' | 'document' | 'selfie';

/** No control characters; the text is shown to administrators as typed. */
function plainText(raw: unknown, max: number): string | null {
  const value = typeof raw === 'string' ? raw.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
  if (!value || charLength(value) > max || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

/** A pathname this user's upload ticket could have produced: `kyc/<user>/<uuid>.<ext>`. */
export function kycPathname(userId: string, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const extensions = Object.values(KYC_IMAGE_TYPES).join('|');
  const pattern = new RegExp(`^kyc/${userId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:${extensions})$`);
  return pattern.test(raw) ? raw : null;
}

/** The document is still valid on `today` (a UTC+8 reporting day): it expires on that day at the earliest. */
export function documentValid(expires: string | null | undefined, today: string): boolean {
  return typeof expires === 'string' && validReportDate(expires) && expires >= today;
}

/**
 * The form of 8.4 step 6: legal name ≤ 100, country ≤ 80, one of three
 * document kinds, exactly four letters or digits, an expiry not before
 * today, W-8BEN or W-9, both declarations, and two different images the user
 * uploaded. The first failing field is answered.
 */
export function parseKycSubmission(userId: string, input: Record<string, unknown>, today: string): KycSubmission | { error: KycInputError } {
  const legalName = plainText(input.legalName, KYC_LIMITS.legalName);
  if (!legalName) return { error: 'legal_name' };
  const country = plainText(input.country, KYC_LIMITS.country);
  if (!country) return { error: 'country' };
  if (!(KYC_DOCUMENT_KINDS as readonly unknown[]).includes(input.documentKind)) return { error: 'document_kind' };
  const last4 = typeof input.documentLast4 === 'string' ? input.documentLast4.trim().toUpperCase() : '';
  if (!new RegExp(`^[A-Z0-9]{${KYC_LIMITS.last4}}$`).test(last4)) return { error: 'last4' };
  const expires = typeof input.documentExpires === 'string' ? input.documentExpires.trim() : '';
  if (!documentValid(expires, today)) return { error: 'expires' };
  if (!(TAX_FORMS as readonly unknown[]).includes(input.taxForm)) return { error: 'tax_form' };
  if (input.declared !== true) return { error: 'declared' };
  if (input.consent !== true) return { error: 'consent' };
  const documentBlob = kycPathname(userId, input.documentBlob);
  if (!documentBlob) return { error: 'document' };
  const selfieBlob = kycPathname(userId, input.selfieBlob);
  if (!selfieBlob || selfieBlob === documentBlob) return { error: 'selfie' };
  return {
    legalName,
    country,
    documentKind: input.documentKind as DocumentKind,
    documentLast4: last4,
    documentExpires: expires,
    taxForm: input.taxForm as TaxForm,
    documentBlob,
    selfieBlob,
  };
}

export interface ReviewableRecord {
  status: KycStatus;
  documentExpires: string | null;
  taxDeclaredAt: Date | null;
  documentBlob: string | null;
  selfieBlob: string | null;
  filesDeletedAt: Date | null;
  resetAt: Date | null;
}

export type KycApprovalError = 'stale' | 'matched' | 'expired' | 'files' | 'declared';

/**
 * Approval needs the newest record still pending, the reviewer's "已比对"
 * tick, an unexpired document, the tax declaration and both images on file
 * (8.2 "KYC 表单", prototype `decideKyc`).
 */
export function approvalBlocker(record: ReviewableRecord, latest: boolean, matched: boolean, today: string): KycApprovalError | null {
  if (!latest || record.status !== 'pending' || record.resetAt) return 'stale';
  if (!matched) return 'matched';
  if (!documentValid(record.documentExpires, today)) return 'expired';
  if (!record.taxDeclaredAt) return 'declared';
  if (!record.documentBlob || !record.selfieBlob || record.filesDeletedAt) return 'files';
  return null;
}

export interface RetainedRecord {
  status: KycStatus;
  decidedAt: Date | null;
  resetAt: Date | null;
  documentBlob: string | null;
  selfieBlob: string | null;
  filesDeletedAt: Date | null;
}

/**
 * When the images must be gone: 30 days after approval, and likewise after a
 * rejection or a re-verification request (the privacy policy, step 3). A
 * pending submission keeps them; so does a record without images.
 */
export function filesDueAt(record: RetainedRecord): Date | null {
  if (record.filesDeletedAt || (!record.documentBlob && !record.selfieBlob)) return null;
  const starts: number[] = [];
  if ((record.status === 'verified' || record.status === 'rejected') && record.decidedAt) starts.push(record.decidedAt.getTime());
  if (record.resetAt) starts.push(record.resetAt.getTime());
  if (!starts.length) return null;
  return new Date(Math.min(...starts) + KYC_FILE_RETENTION_DAYS * DAY);
}

export function filesDue(record: RetainedRecord, now: Date): boolean {
  const due = filesDueAt(record);
  return due !== null && due.getTime() <= now.getTime();
}
