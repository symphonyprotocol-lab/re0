'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { VERIFICATION_LINK_MAX, VERIFICATION_LINKS_MAX, VERIFICATION_STATEMENT_MAX } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';

type ErrorCode = 'statement' | 'links' | 'requirements' | 'pending' | 'cooldown' | 'role' | 'disabled' | 'failed';

/**
 * The verification application (prototype `#role-application`): a statement
 * of up to 500 characters with a live count and up to three optional links.
 * Disabled unless the server says the user may apply; the server checks the
 * threshold again on submit, and its refusal shows inline.
 */
export function RoleApplication({ eligible, note }: { eligible: boolean; note: string }) {
  const { t } = useI18n();
  const a = t.roles.apply;
  const router = useRouter();
  const toast = useToast();
  const [statement, setStatement] = useState('');
  const [links, setLinks] = useState<string[]>(() => Array.from({ length: VERIFICATION_LINKS_MAX }, () => ''));
  const [error, setError] = useState<ErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const count = Array.from(statement).length;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!eligible || busy) return;
    const text = statement.trim();
    if (!text || Array.from(text).length > VERIFICATION_STATEMENT_MAX) {
      setError('statement');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await api<{ error?: string }>('/api/account/verification', {
      method: 'POST',
      json: { statement: text, links: links.map((link) => link.trim()).filter(Boolean) },
    }).catch(() => ({ ok: false, status: 0, data: { error: 'failed' } }));
    setBusy(false);
    if (!result.ok) {
      const code = result.data.error ?? 'failed';
      setError((code in a.errors ? code : 'failed') as ErrorCode);
      return;
    }
    setStatement('');
    setLinks(links.map(() => ''));
    toast(a.submitted);
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="mt-3" noValidate>
      <p className={`rounded-lg border px-3 py-2.5 text-[12px] leading-relaxed ${eligible ? 'border-[#cfe9df] bg-[#eef8f4] text-green' : 'border-[#e8edf7] bg-[#f6f8fd] text-muted'}`}>{note}</p>
      <fieldset disabled={!eligible || busy} className="mt-4 min-w-0 disabled:opacity-60">
        <label htmlFor="role-statement" className="field-label flex items-center justify-between gap-3">
          {a.statement}
          <small className={`font-mono text-[11px] font-normal ${count > VERIFICATION_STATEMENT_MAX ? 'text-red' : 'text-muted'}`} aria-live="polite">
            {count} / {VERIFICATION_STATEMENT_MAX}
          </small>
        </label>
        <textarea
          id="role-statement"
          name="statement"
          rows={6}
          required
          maxLength={VERIFICATION_STATEMENT_MAX * 2}
          value={statement}
          onChange={(event) => setStatement(event.target.value)}
          placeholder={a.statementPlaceholder}
          aria-invalid={error === 'statement' || undefined}
          className="input resize-y leading-relaxed"
        />
        <p className="field-label mt-4">{a.links}</p>
        <div className="flex flex-col gap-2">
          {links.map((link, index) => (
            <input
              key={index}
              type="url"
              inputMode="url"
              maxLength={VERIFICATION_LINK_MAX}
              placeholder="https://"
              aria-label={fill(a.link, { n: index + 1 })}
              aria-invalid={error === 'links' || undefined}
              value={link}
              onChange={(event) => setLinks(links.map((value, at) => (at === index ? event.target.value : value)))}
              className="input"
            />
          ))}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="mt-3 flex items-start gap-1.5 text-[12px] text-red">
          <Icon name="info" className="mt-0.5 size-3.5 flex-none" />
          {a.errors[error]}
        </p>
      )}
      <button type="submit" className="btn mt-4 w-full" disabled={!eligible || busy}>
        {busy ? <Spinner /> : null}
        {a.submit}
        {!busy && <Icon name="arrow" />}
      </button>
      <p className="mt-3 text-[11px] leading-relaxed text-muted">{a.footnote}</p>
    </form>
  );
}
