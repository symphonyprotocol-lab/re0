'use client';

import { useState } from 'react';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { Spinner } from '@/components/ui/icons';
import { I } from '@/components/settings/icon';
import type { GrantPermissions } from '@/lib/domain/oauth';

/**
 * The consent page's choice (app/oauth/consent/[id]/page.tsx): the same
 * permissions as an API key -- an account connection (read + ask, optionally
 * "allow changes", workspace none/read/write) or a workspace-only one under
 * a root folder -- then approve or deny. The server answers with the
 * client's redirect URI, which the browser follows.
 */
export function ConsentForm({ id, suggested }: { id: string; suggested: GrantPermissions }) {
  const { t } = useI18n();
  const a = t.apiKeys;
  const o = t.oauth;
  const [kind, setKind] = useState<'account' | 'workspace'>(suggested.workspaceOnly ? 'workspace' : 'account');
  const [canWrite, setCanWrite] = useState(suggested.canWrite);
  const [access, setAccess] = useState<'none' | 'read' | 'write'>(suggested.workspaceAccess);
  const [root, setRoot] = useState(suggested.workspaceRoot);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState('');
  const [leaving, setLeaving] = useState(false);

  const decide = async (approve: boolean) => {
    setError('');
    setBusy(approve ? 'approve' : 'deny');
    const result = await api<{ redirect?: string; error?: string }>(`/oauth/consent/${id}/decide`, {
      method: 'POST',
      json: { approve, permissions: { canWrite: kind === 'account' && canWrite, workspaceAccess: access, workspaceOnly: kind === 'workspace', workspaceRoot: root } },
    });
    if (!result.ok || !result.data.redirect) {
      setBusy(null);
      const code = result.data.error as keyof typeof o.errors | undefined;
      return setError(code && code in o.errors ? o.errors[code] : t.common.errors.generic);
    }
    setLeaving(true);
    window.location.assign(result.data.redirect);
  };

  return (
    <form
      className="oauth-form"
      onSubmit={(event) => {
        event.preventDefault();
        void decide(true);
      }}
    >
      <h2>{o.permissions.title}</h2>
      <div className="api-key-kinds" role="radiogroup" aria-label={o.permissions.kind}>
        {(['account', 'workspace'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={kind === value}
            className={kind === value ? 'is-on' : undefined}
            onClick={() => {
              setKind(value);
              if (value === 'workspace' && access === 'none') setAccess('read');
            }}
          >
            <I name={value === 'workspace' ? 'folder' : 'key'} />
            <strong>{o.permissions.kinds[value]}</strong>
            <small>{o.permissions.kindHints[value]}</small>
          </button>
        ))}
      </div>
      {kind === 'workspace' && (
        <div className="field">
          <label htmlFor="oauth-root">{a.form.root}</label>
          <input id="oauth-root" className="mono" value={root} maxLength={1024} onChange={(event) => setRoot(event.target.value)} />
          <p className="form-hint">{o.permissions.rootHint}</p>
        </div>
      )}
      {kind === 'account' && (
        <label className="check-row api-key-write">
          <span>
            <strong>{a.form.write}</strong>
            <small>{o.permissions.writeHint}</small>
          </span>
          <input type="checkbox" checked={canWrite} onChange={(event) => setCanWrite(event.target.checked)} />
        </label>
      )}
      <div className="field">
        <span className="field-label">{a.form.workspace}</span>
        <div className="api-key-access-options" role="radiogroup" aria-label={a.form.workspace}>
          {(kind === 'workspace' ? (['read', 'write'] as const) : (['none', 'read', 'write'] as const)).map((value) => (
            <label key={value} className={access === value ? 'is-on' : undefined}>
              <input type="radio" name="oauth-workspace" checked={access === value} onChange={() => setAccess(value)} />
              <span>
                <strong>{a.workspaceAccess[value]}</strong>
                <small>{a.workspaceAccessHints[value]}</small>
              </span>
            </label>
          ))}
        </div>
        {kind === 'workspace' && <p className="form-hint">{o.permissions.workspaceOnlyHint}</p>}
      </div>
      <div className="info-strip">
        <I name="wallet" />
        <span>{o.permissions.spendNote}</span>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {leaving ? (
        <p role="status" className="muted small oauth-leaving">
          <Spinner /> {o.redirecting}
        </p>
      ) : (
        <div className="oauth-actions">
          <button type="button" className="btn secondary" disabled={busy !== null} onClick={() => void decide(false)}>
            {busy === 'deny' && <Spinner />}
            {o.deny}
          </button>
          <button type="submit" className="btn" disabled={busy !== null}>
            {busy === 'approve' && <Spinner />}
            {o.approve}
          </button>
        </div>
      )}
    </form>
  );
}
