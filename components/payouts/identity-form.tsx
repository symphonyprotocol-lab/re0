'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { KYC_DOCUMENT_KINDS, KYC_IMAGE_MAX_BYTES, KYC_IMAGE_TYPES, KYC_LIMITS, TAX_FORMS } from '@/lib/constants';
import type { KycSlot, KycState } from '@/lib/domain/kyc';
import { api } from '@/lib/client/upload';
import { uploadKycImage } from '@/lib/client/kyc-upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';

export interface IdentityRecord {
  legalName: string | null;
  country: string | null;
  documentKind: (typeof KYC_DOCUMENT_KINDS)[number] | null;
  documentLast4: string | null;
  documentExpires: string | null;
  taxForm: (typeof TAX_FORMS)[number] | null;
  declared: boolean;
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
  hasDocument: boolean;
  hasSelfie: boolean;
  filesDeleted: boolean;
}

type Upload = { name: string; pathname: string | null; progress: number | null };

/**
 * `/settings/identity` (prototype manual-kyc.js `userPage`): three cards --
 * identity details, the two images uploaded straight to private Blob, the
 * tax form and both declarations -- beside a guide. Read-only while the
 * submission waits and once verified; after a rejection or a
 * re-verification request the form opens again, prefilled except for the
 * images.
 */
export function IdentityForm({ state, record, today }: { state: KycState; record: IdentityRecord | null; today: string }) {
  const { t, locale } = useI18n();
  const p = t.payouts;
  const f = p.identity;
  const router = useRouter();
  const toast = useToast();
  const locked = state === 'pending' || state === 'verified';
  const [uploads, setUploads] = useState<Record<KycSlot, Upload | null>>({ document: null, selfie: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const errors = f.errors as Record<string, string>;

  async function pick(slot: KycSlot, file: File | undefined) {
    if (!file) return;
    setError('');
    if (!KYC_IMAGE_TYPES[file.type] || file.size <= 0 || file.size > KYC_IMAGE_MAX_BYTES) {
      setError(errors.invalid_image!);
      return;
    }
    setUploads((current) => ({ ...current, [slot]: { name: file.name, pathname: null, progress: 0 } }));
    const result = await uploadKycImage(file, (progress) => setUploads((current) => ({ ...current, [slot]: { name: file.name, pathname: null, progress } })));
    if ('error' in result) {
      setUploads((current) => ({ ...current, [slot]: null }));
      setError(errors[result.error] ?? errors.upload!);
      return;
    }
    setUploads((current) => ({ ...current, [slot]: { name: file.name, pathname: result.pathname, progress: null } }));
  }

  async function submit(form: HTMLFormElement) {
    const data = new FormData(form);
    setBusy(true);
    setError('');
    const result = await api<{ error?: string }>('/api/billing/kyc', {
      method: 'POST',
      json: {
        legalName: data.get('legalName'),
        country: data.get('country'),
        documentKind: data.get('documentKind'),
        documentLast4: data.get('documentLast4'),
        documentExpires: data.get('documentExpires'),
        taxForm: data.get('taxForm'),
        declared: data.has('declared'),
        consent: data.has('consent'),
        documentBlob: uploads.document?.pathname ?? null,
        selfieBlob: uploads.selfie?.pathname ?? null,
      },
    });
    setBusy(false);
    if (!result.ok) {
      setError(errors[result.data.error ?? ''] ?? errors.generic!);
      return;
    }
    toast(f.submittedToast);
    router.refresh();
  }

  const uploading = Object.values(uploads).some((upload) => upload && upload.progress !== null);
  const feedback = record?.reason && (state === 'rejected' || state === 'reset') ? record.reason : null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-extrabold">{locked ? f.submittedTitle : f.submitTitle}</h1>
          <p className="mt-1 text-[13px] text-muted">{locked ? f.submittedIntro : f.submitIntro}</p>
        </div>
        {state !== 'none' && <KycStateTag state={state} label={p.kyc.status[state]} />}
      </div>
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget);
          }}
        >
          <fieldset disabled={locked || busy} className="flex min-w-0 flex-col gap-4">
            <Section index="01" title={f.section1.title} body={f.section1.body}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="kyc-name" label={f.legalName}>
                  <input id="kyc-name" name="legalName" className="input" required maxLength={KYC_LIMITS.legalName} autoComplete="off" placeholder={f.legalNamePlaceholder} defaultValue={record?.legalName ?? ''} />
                </Field>
                <Field id="kyc-country" label={f.country}>
                  <input id="kyc-country" name="country" className="input" required maxLength={KYC_LIMITS.country} placeholder={f.countryPlaceholder} defaultValue={record?.country ?? ''} />
                </Field>
                <Field id="kyc-kind" label={f.documentKind}>
                  <select id="kyc-kind" name="documentKind" className="input pr-8" defaultValue={record?.documentKind ?? 'passport'}>
                    {KYC_DOCUMENT_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {p.kyc.kinds[kind]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id="kyc-last4" label={f.last4} hint={f.last4Hint}>
                  <input
                    id="kyc-last4"
                    name="documentLast4"
                    className="input font-mono uppercase"
                    required
                    minLength={KYC_LIMITS.last4}
                    maxLength={KYC_LIMITS.last4}
                    pattern="[A-Za-z0-9]{4}"
                    placeholder="2048"
                    autoComplete="off"
                    defaultValue={record?.documentLast4 ?? ''}
                  />
                </Field>
              </div>
              <Field id="kyc-expires" label={f.expires} className="mt-4 sm:max-w-[calc(50%-8px)]">
                <input id="kyc-expires" name="documentExpires" type="date" className="input" required min={locked ? undefined : today} defaultValue={record?.documentExpires ?? ''} />
              </Field>
            </Section>

            <Section index="02" title={f.section2.title} body={f.section2.body}>
              <div className="grid gap-4 sm:grid-cols-2">
                {(['document', 'selfie'] as const).map((slot) => {
                  const upload = uploads[slot];
                  const submitted = locked && (slot === 'document' ? record?.hasDocument : record?.hasSelfie);
                  const deleted = locked && record?.filesDeleted;
                  const status = deleted ? f.deleted : submitted ? f.submitted : upload ? (upload.progress !== null ? fill(f.uploading, { n: upload.progress }) : f.uploaded) : f.choose;
                  const detail = deleted ? f.deletedHint : upload ? upload.name : slot === 'document' ? f.documentHint : f.selfieHint;
                  return (
                    <div key={slot} className="min-w-0">
                      <span className="field-label">{slot === 'document' ? f.document : f.selfie}</span>
                      <label
                        htmlFor={`kyc-${slot}`}
                        className={`flex min-h-[112px] min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-3 py-4 text-center transition ${upload?.pathname || submitted ? 'border-[#cde8df] bg-[#f4fbf8]' : 'border-line bg-wash hover:border-blue'} ${locked ? 'cursor-default' : ''}`}
                      >
                        {upload?.progress !== null && upload ? (
                          <Spinner className="size-5 text-blue" />
                        ) : (
                          <Icon name={upload?.pathname || submitted ? 'check' : slot === 'document' ? 'file' : 'users'} className={`size-5 ${upload?.pathname || submitted ? 'text-green' : 'text-muted'}`} />
                        )}
                        <strong className="text-[13px]">{status}</strong>
                        <span className="max-w-full truncate text-[11px] text-muted">{detail}</span>
                        <input
                          id={`kyc-${slot}`}
                          type="file"
                          accept={Object.keys(KYC_IMAGE_TYPES).join(',')}
                          className="sr-only"
                          disabled={locked || busy}
                          onChange={(event) => {
                            void pick(slot, event.target.files?.[0]);
                            event.target.value = '';
                          }}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
              <p className="hint mt-3">{f.imageHint}</p>
            </Section>

            <Section index="03" title={f.section3.title} body={f.section3.body}>
              <Field id="kyc-tax" label={f.taxForm}>
                <select id="kyc-tax" name="taxForm" className="input pr-8" defaultValue={record?.taxForm ?? 'W-8BEN'}>
                  {TAX_FORMS.map((form) => (
                    <option key={form} value={form}>
                      {p.kyc.taxForms[form]}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="mt-4 flex items-start gap-2.5 text-[13px] leading-relaxed">
                <input type="checkbox" name="declared" required className="mt-1 size-4 flex-none accent-blue" defaultChecked={locked && record?.declared} />
                {f.declared}
              </label>
              <label className="mt-3 flex items-start gap-2.5 text-[13px] leading-relaxed">
                <input type="checkbox" name="consent" required className="mt-1 size-4 flex-none accent-blue" defaultChecked={locked} />
                {f.consent}
              </label>
            </Section>
          </fieldset>
          {error && (
            <p role="alert" className="rounded-lg bg-[#fff3f3] px-3 py-2 text-[12px] text-red">
              {error}
            </p>
          )}
          {!locked && (
            <div className="flex flex-wrap justify-end gap-2">
              <Link href="/settings?tab=billing" className="btn-secondary">
                {f.cancel}
              </Link>
              <button type="submit" className="btn" disabled={busy || uploading}>
                {busy ? <Spinner /> : null}
                {f.submit}
                {!busy && <Icon name="arrow" />}
              </button>
            </div>
          )}
        </form>
        <aside className="flex min-w-0 flex-col gap-4">
          <section className="card p-5">
            <span className="inline-flex size-9 items-center justify-center rounded-xl bg-soft text-blue">
              <Icon name="shield" />
            </span>
            <h2 className="mt-3 text-[15px] font-bold">{locked ? p.kyc.status[state] : f.guideTitle}</h2>
            <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5 text-[12px] leading-relaxed text-muted">
              {f.guide.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {locked && record && (
              <p className="hint mt-4 leading-relaxed">
                {f.lockedNote}
                <br />
                {fill(f.submittedAt, { time: formatDateTime(record.createdAt, locale) })}
                {record.decidedAt && state === 'verified' && (
                  <>
                    <br />
                    {fill(f.reviewedAt, { time: formatDateTime(record.decidedAt, locale) })}
                  </>
                )}
              </p>
            )}
            {feedback && (
              <div role="status" className="mt-4 rounded-lg border border-[#f0dcc2] bg-[#fff7ec] px-3 py-2.5 text-[12px]">
                <strong className="block text-orange">{f.feedback}</strong>
                <p className="mt-1 break-words whitespace-pre-line">{feedback}</p>
              </div>
            )}
          </section>
          <section className="rounded-xl border border-[#dfe6f5] bg-wash p-5">
            <h3 className="text-[13px] font-bold">{f.protectTitle}</h3>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">{f.protectBody}</p>
          </section>
          <Link href="/settings?tab=billing" className="text-link text-[12px]">
            <Icon name="arrowLeft" className="size-3.5" />
            {f.back}
          </Link>
        </aside>
      </div>
    </div>
  );
}

export function KycStateTag({ state, label }: { state: KycState; label: string }) {
  const tone =
    state === 'verified'
      ? 'border-[#cde8df] bg-[#effaf6] text-green'
      : state === 'rejected'
        ? 'border-[#f1d4d4] bg-[#fff3f3] text-red'
        : state === 'none'
          ? ''
          : 'border-[#f0dcc2] bg-[#fff7ec] text-orange';
  return (
    <span className={`tag whitespace-nowrap ${tone}`}>
      {state === 'verified' && <Icon name="check" className="size-3" />}
      {label}
    </span>
  );
}

function Section({ index, title, body, children }: { index: string; title: string; body: string; children: ReactNode }) {
  return (
    <section className="card min-w-0 p-5 md:p-6">
      <div className="mb-4 flex items-start gap-3">
        <span className="font-mono text-[12px] font-bold text-blue">{index}</span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold">{title}</h2>
          <p className="mt-0.5 text-[12px] text-muted">{body}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Field({ id, label, hint, className = '', children }: { id: string; label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {children}
      {hint && <small className="hint">{hint}</small>}
    </div>
  );
}
