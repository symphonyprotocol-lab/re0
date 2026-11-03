'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { VERIFICATION_LINK_MAX, VERIFICATION_LINKS_MAX, VERIFICATION_STATEMENT_MAX } from '@/lib/constants';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Spinner } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { I } from '@/components/settings/icon';

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
    <>
      <p className="role-state-note">{note}</p>
      <form id="role-application" onSubmit={submit} noValidate>
        <fieldset disabled={!eligible || busy}>
          <label htmlFor="role-statement">
            {a.statement}{' '}
            <small aria-live="polite" className={count > VERIFICATION_STATEMENT_MAX ? 'role-count-over' : undefined}>
              {count} / {VERIFICATION_STATEMENT_MAX}
            </small>
          </label>
          <textarea
            id="role-statement"
            name="statement"
            rows={6}
            required
            maxLength={VERIFICATION_STATEMENT_MAX}
            value={statement}
            onChange={(event) => setStatement(event.target.value)}
            placeholder={a.statementPlaceholder}
            aria-invalid={error === 'statement' || undefined}
          />
          <label>{a.links}</label>
          {links.map((link, index) => (
            <input
              key={index}
              name="link"
              type="url"
              inputMode="url"
              maxLength={VERIFICATION_LINK_MAX}
              placeholder="https://"
              aria-label={fill(a.link, { n: index + 1 })}
              aria-invalid={error === 'links' || undefined}
              value={link}
              onChange={(event) => setLinks(links.map((value, at) => (at === index ? event.target.value : value)))}
            />
          ))}
        </fieldset>
        <button type="submit" className="btn full" disabled={!eligible || busy}>
          {busy && <Spinner />}
          {a.submit}
          {!busy && <I name="arrow" />}
        </button>
        <p className="role-footnote">{a.footnote}</p>
        {error && (
          <p role="alert" className="form-error role-form-error">
            {a.errors[error]}
          </p>
        )}
      </form>
    </>
  );
}
