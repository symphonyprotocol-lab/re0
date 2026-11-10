'use client';

import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useEffect, useState } from 'react';
import { dnsRecordName, wellKnownUrl } from '@/lib/domain/sources';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime } from '@/i18n/format';
import { Spinner } from '@/components/ui/icons';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { I } from '@/components/settings/icon';

export interface DomainRow {
  id: string;
  domain: string;
  status: 'pending' | 'verified' | 'failed';
  method: 'dns_txt' | 'well_known' | null;
  challenge: string;
  checkedAt: string | null;
}

type Method = 'dns_txt' | 'well_known';

/**
 * `/settings?tab=connections` (prototype app.js "连接与域名"): connect or
 * disconnect GitHub for repository imports, and the domains verified for
 * website crawls -- add, a two-method verification wizard, remove.
 */
export function Connections({
  github,
  githubAccess,
  domains: initialDomains,
  outcome,
}: {
  github: { login: string } | null;
  githubAccess: { app: boolean; url: string };
  domains: DomainRow[];
  /** `?github=` after the connect flow returned. */
  outcome: 'connected' | 'canceled' | 'failed' | null;
}) {
  const { t, locale } = useI18n();
  const c = t.settings.connections;
  const router = useRouter();
  const toast = useToast();
  const [domains, setDomains] = useState(initialDomains);
  const [disconnecting, setDisconnecting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [wizard, setWizard] = useState<{ domain: DomainRow; method: Method } | null>(null);
  const [removing, setRemoving] = useState<DomainRow | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => setDomains(initialDomains), [initialDomains]);
  useEffect(() => {
    if (!outcome) return;
    toast(c.outcome[outcome]);
    router.replace('/settings?tab=connections', { scroll: false });
  }, [outcome, c.outcome, router, toast]);

  const reload = async () => {
    const result = await api<{ items: DomainRow[] }>('/api/domains');
    if (result.ok) setDomains(result.data.items);
  };

  const add = async () => {
    setError('');
    setBusy(true);
    const result = await api<{ domain?: DomainRow; error?: string }>('/api/domains', { method: 'POST', json: { domain: name } });
    setBusy(false);
    if (!result.ok || !result.data.domain) {
      const code = result.data.error as keyof typeof t.settings.errors | undefined;
      return setError(code && code in t.settings.errors ? t.settings.errors[code] : t.common.errors.generic);
    }
    setAdding(false);
    setName('');
    await reload();
    setWizard({ domain: result.data.domain, method: 'dns_txt' });
  };

  const verify = async () => {
    if (!wizard) return;
    setError('');
    setBusy(true);
    const result = await api<{ outcome?: 'verified' | 'not_found' | 'unreachable'; domain?: DomainRow; error?: string }>(`/api/domains/${wizard.domain.id}/verify`, {
      method: 'POST',
      json: { method: wizard.method },
    });
    setBusy(false);
    await reload();
    if (result.data.outcome === 'verified') {
      setWizard(null);
      toast(c.verified);
      return;
    }
    setError(result.data.outcome === 'unreachable' ? c.unreachable : result.data.outcome === 'not_found' ? c.notFound : t.common.errors.generic);
  };

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value).then(() => toast(c.copied), () => toast(t.common.errors.generic));
  };

  const row = (label: string, value: string) => (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );

  return (
    <>
      <section className="card settings-card">
        <h2>{c.accounts}</h2>
        <p className="muted">{c.accountsBody}</p>
        <div className="settings-row">
          <div className="s-flex min-w-0">
            <span className="connection-icon">
              <I name="github" />
            </span>
            <div className="min-w-0">
              <h3>
                GitHub {github && <span className="tag green">{c.connected}</span>}
              </h3>
              <p>{github ? fill(c.githubConnected, { login: github.login }) : c.githubIdle}</p>
            </div>
          </div>
          {github ? (
            <button type="button" className="btn secondary" onClick={() => setDisconnecting(true)}>
              {c.disconnect}
            </button>
          ) : (
            <form method="post" action="/api/auth/github/connect">
              <input type="hidden" name="returnTo" value="/settings?tab=connections" />
              <button type="submit" className="btn secondary">
                {c.connect}
              </button>
            </form>
          )}
        </div>
        <div className="info-strip mt24">
          <I name="shield" />
          <div>
            <p>{c.githubNote}</p>
            <p>{githubAccess.app ? c.githubAppAccess : c.githubOauthAccess}</p>
            <a className="text-link" href={githubAccess.url} target="_blank" rel="noreferrer">{c.githubManage}</a>
            {github && (
              <form method="post" action="/api/auth/github/connect">
                <input type="hidden" name="returnTo" value="/settings?tab=connections" />
                <button type="submit" className="text-link">{c.githubReconnect}</button>
              </form>
            )}
          </div>
        </div>
      </section>

      <section className="card settings-card">
        <div className="between">
          <div>
            <h2>{c.domains}</h2>
            <p className="muted small domains-lede">{c.domainsBody}</p>
          </div>
          <button
            type="button"
            className="btn secondary sm"
            onClick={() => {
              setError('');
              setAdding(true);
            }}
          >
            <I name="plus" />
            {c.addDomain}
          </button>
        </div>
        <div className="mt24">
          {domains.length === 0 && <p className="small muted">{c.noDomains}</p>}
          {domains.map((domain) => (
            <div key={domain.id} className="domain-row">
              <div className="min-w-0">
                <h3>{domain.domain}</h3>
                <small>
                  {domain.method ? c.method[domain.method] : `${c.method.dns_txt} / ${c.method.well_known}`} · {c.shared}
                  {domain.checkedAt && domain.status !== 'verified' && ` · ${fill(c.lastChecked, { time: formatDateTime(domain.checkedAt, locale) })}`}
                </small>
              </div>
              <div className="s-flex flex-none">
                <span className={`tag ${domain.status === 'verified' ? 'green' : domain.status === 'failed' ? 'red' : 'orange'}`}>
                  <I name={domain.status === 'verified' ? 'check' : 'clock'} />
                  {c.status[domain.status]}
                </span>
                {domain.status !== 'verified' && (
                  <button
                    type="button"
                    className="btn secondary sm"
                    onClick={() => {
                      setError('');
                      setWizard({ domain, method: domain.method ?? 'dns_txt' });
                    }}
                  >
                    {c.continue}
                  </button>
                )}
                <button type="button" className="icon-btn" aria-label={c.remove} title={c.remove} onClick={() => setRemoving(domain)}>
                  <I name="trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <ConfirmModal
        open={disconnecting}
        title={c.disconnectTitle}
        body={c.disconnectBody}
        confirmLabel={c.disconnect}
        danger
        onClose={() => setDisconnecting(false)}
        onConfirm={async () => {
          setDisconnecting(false);
          const result = await api('/api/auth/github/connect', { method: 'DELETE' });
          if (!result.ok) return toast(t.common.errors.generic);
          router.refresh();
        }}
      />

      <ConfirmModal
        open={Boolean(removing)}
        title={c.removeTitle}
        body={c.removeBody}
        confirmLabel={c.removeConfirm}
        danger
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          const domain = removing!;
          setRemoving(null);
          await api(`/api/domains/${domain.id}`, { method: 'DELETE' });
          await reload();
        }}
      />

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={c.wizardAddTitle}
        subtitle={c.wizardSubtitle}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setAdding(false)}>
              {t.common.actions.cancel}
            </button>
            <button type="submit" form="domain-form" className="btn" disabled={busy}>
              {busy && <Spinner />}
              {c.next}
            </button>
          </>
        }
      >
        <form
          id="domain-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="field">
            <label htmlFor="domain-name">{c.domainLabel}</label>
            <input id="domain-name" value={name} placeholder="docs.example.com" maxLength={253} required autoFocus onChange={(event) => setName(event.target.value)} />
            <small>{c.domainHint}</small>
          </div>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </form>
      </Modal>

      <Modal
        open={Boolean(wizard)}
        onClose={() => setWizard(null)}
        title={c.wizardVerifyTitle}
        subtitle={c.wizardSubtitle}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setWizard(null)}>
              {t.common.actions.cancel}
            </button>
            <button type="button" className="btn" onClick={verify} disabled={busy}>
              {busy && <Spinner />}
              {c.verify}
            </button>
          </>
        }
      >
        {wizard && (
          <div>
            <p className="mono small mb16 break-all">{wizard.domain.domain}</p>
            <div className="radio-tabs" role="tablist">
              {(['dns_txt', 'well_known'] as const).map((method) => (
                <button
                  key={method}
                  type="button"
                  role="tab"
                  aria-selected={wizard.method === method}
                  className={wizard.method === method ? 'active' : ''}
                  onClick={() => setWizard({ ...wizard, method })}
                >
                  {c.method[method]}
                </button>
              ))}
            </div>
            <p className="form-hint mb16">{wizard.method === 'dns_txt' ? c.dnsHint : c.fileHint}</p>
            <dl className="code-block domain-record">
              {wizard.method === 'dns_txt' ? (
                <>
                  {row(c.host, dnsRecordName(wizard.domain.domain))}
                  {row(c.type, 'TXT')}
                  {row(c.value, wizard.domain.challenge)}
                </>
              ) : (
                <>
                  {row(c.filePath, wellKnownUrl(wizard.domain.domain))}
                  {row(c.fileContent, wizard.domain.challenge)}
                </>
              )}
            </dl>
            <button type="button" className="btn secondary full mt16" onClick={() => copy(wizard.domain.challenge)}>
              <I name="copy" />
              {c.copy}
            </button>
            <div className="info-strip mt16">
              <I name="info" />
              <span>{c.either}</span>
            </div>
            {error && (
              <p role="alert" className="form-error mt16">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
