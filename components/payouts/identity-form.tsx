'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { KYC_DOCUMENT_KINDS, KYC_IMAGE_MAX_BYTES, KYC_IMAGE_TYPES, KYC_LIMITS, TAX_FORMS } from '@/lib/constants';
import type { KycSlot, KycState } from '@/lib/domain/kyc';
import { api } from '@/lib/client/upload';
import { uploadKycImage } from '@/lib/client/kyc-upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime } from '@/i18n/format';
import { Spinner } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { I } from '@/components/settings/icon';

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
    <>
      <div className="kyc-page-intro">
        <div>
          <h1>{locked ? f.submittedTitle : f.submitTitle}</h1>
          <p>{locked ? f.submittedIntro : f.submitIntro}</p>
        </div>
        {state !== 'none' && <KycStateTag state={state} label={p.kyc.status[state]} />}
      </div>
      <div className="kyc-page-layout">
        <form
          id="manual-kyc-form"
          className="kyc-page-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget);
          }}
        >
          <fieldset className="kyc-page-fields" disabled={locked || busy}>
            <Section index="01" title={f.section1.title} body={f.section1.body}>
              <div className="two-col">
                <div className="field">
                  <label htmlFor="kyc-name">{f.legalName}</label>
                  <input id="kyc-name" name="legalName" required maxLength={KYC_LIMITS.legalName} autoComplete="off" placeholder={f.legalNamePlaceholder} defaultValue={record?.legalName ?? ''} />
                </div>
                <div className="field">
                  <label htmlFor="kyc-country">{f.country}</label>
                  <input id="kyc-country" name="country" required maxLength={KYC_LIMITS.country} placeholder={f.countryPlaceholder} defaultValue={record?.country ?? ''} />
                </div>
              </div>
              <div className="two-col">
                <div className="field">
                  <label htmlFor="kyc-kind">{f.documentKind}</label>
                  <select id="kyc-kind" name="documentKind" defaultValue={record?.documentKind ?? 'passport'}>
                    {KYC_DOCUMENT_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {p.kyc.kinds[kind]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="kyc-last4">{f.last4}</label>
                  <input
                    id="kyc-last4"
                    name="documentLast4"
                    required
                    minLength={KYC_LIMITS.last4}
                    maxLength={KYC_LIMITS.last4}
                    pattern="[A-Za-z0-9]{4}"
                    title={f.last4Hint}
                    placeholder="2048"
                    autoComplete="off"
                    defaultValue={record?.documentLast4 ?? ''}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="kyc-expires">{f.expires}</label>
                <input id="kyc-expires" name="documentExpires" type="date" required min={locked ? undefined : today} defaultValue={record?.documentExpires ?? ''} />
              </div>
            </Section>

            <Section index="02" title={f.section2.title} body={f.section2.body}>
              <div className="two-col">
                {(['document', 'selfie'] as const).map((slot) => {
                  const upload = uploads[slot];
                  const submitted = locked && (slot === 'document' ? record?.hasDocument : record?.hasSelfie);
                  const deleted = locked && record?.filesDeleted;
                  const status = deleted ? f.deleted : submitted ? f.submitted : upload ? (upload.progress !== null ? fill(f.uploading, { n: upload.progress }) : f.uploaded) : f.choose;
                  const detail = deleted ? f.deletedHint : upload ? upload.name : submitted ? '' : slot === 'document' ? f.documentHint : f.selfieHint;
                  return (
                    <div key={slot} className="field">
                      <label htmlFor={`kyc-${slot}`}>{slot === 'document' ? f.document : f.selfie}</label>
                      <label className={`kyc-upload ${upload?.pathname || submitted ? 'is-done' : ''}`} htmlFor={`kyc-${slot}`}>
                        {upload && upload.progress !== null ? <Spinner /> : <I name={upload?.pathname || submitted ? 'check' : slot === 'document' ? 'file' : 'users'} />}
                        <strong>{status}</strong>
                        <span>{detail}</span>
                        <input
                          id={`kyc-${slot}`}
                          type="file"
                          accept={Object.keys(KYC_IMAGE_TYPES).join(',')}
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
              <p className="form-hint">{f.imageHint}</p>
            </Section>

            <Section index="03" title={f.section3.title} body={f.section3.body}>
              <div className="field">
                <label htmlFor="kyc-tax">{f.taxForm}</label>
                <select id="kyc-tax" name="taxForm" defaultValue={record?.taxForm ?? 'W-8BEN'}>
                  {TAX_FORMS.map((form) => (
                    <option key={form} value={form}>
                      {p.kyc.taxForms[form]}
                    </option>
                  ))}
                </select>
              </div>
              <label className="check-row small">
                <input type="checkbox" name="declared" required defaultChecked={locked && record?.declared} />
                {f.declared}
              </label>
              <label className="check-row small mt16">
                <input type="checkbox" name="consent" required defaultChecked={locked} />
                {f.consent}
              </label>
            </Section>
          </fieldset>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {!locked && (
            <div className="kyc-page-actions">
              <Link href="/settings?tab=balance" className="btn secondary">
                {f.cancel}
              </Link>
              <button type="submit" className="btn" disabled={busy || uploading}>
                {busy && <Spinner />}
                {f.submit}
                {!busy && <I name="arrow" />}
              </button>
            </div>
          )}
        </form>
        <aside className="kyc-page-guide">
          <section className="card kyc-guide-card">
            <span className="kyc-guide-icon">
              <I name="shield" />
            </span>
            <h2>{locked ? p.kyc.status[state] : f.guideTitle}</h2>
            <ol>
              {f.guide.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {locked && record && (
              <p className="form-hint">
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
              <div className="kyc-feedback" role="status">
                <strong>{f.feedback}</strong>
                <p>{feedback}</p>
              </div>
            )}
          </section>
          <section className="kyc-guide-note">
            <h3>{f.protectTitle}</h3>
            <p>{f.protectBody}</p>
          </section>
        </aside>
      </div>
    </>
  );
}

export function KycStateTag({ state, label }: { state: KycState; label: string }) {
  const tone = state === 'verified' ? 'green' : state === 'rejected' ? 'red' : state === 'none' ? '' : 'orange';
  return <span className={`tag ${tone}`}>{label}</span>;
}

function Section({ index, title, body, children }: { index: string; title: string; body: string; children: ReactNode }) {
  return (
    <section className="card kyc-form-section">
      <div className="kyc-section-title">
        <span>{index}</span>
        <div>
          <h2>{title}</h2>
          <p>{body}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
