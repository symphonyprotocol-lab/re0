'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { dnsRecordName, wellKnownUrl } from '@/lib/domain/sources';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

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
 * disconnect GitHub for private repositories, and the domains verified for
 * website crawls -- add, a two-method verification wizard, remove.
 */
export function Connections({
  github,
  domains: initialDomains,
  outcome,
}: {
  github: { login: string } | null;
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
    await navigator.clipboard.writeText(value);
    toast(c.copied);
  };

  const row = (label: string, value: string) => (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="w-24 flex-none text-muted">{label}</dt>
      <dd className="min-w-0 font-mono break-all text-ink">{value}</dd>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="card p-6">
        <h1 className="text-[17px] font-bold">{c.accounts}</h1>
        <p className="mt-1 text-[12px] text-muted">{c.accountsBody}</p>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex size-10 flex-none items-center justify-center rounded-lg bg-wash">
              <Icon name="github" className="size-5" />
            </span>
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-[14px] font-bold">
                GitHub
                {github && <span className="tag border-[#cfe8df] bg-[#e9f6f1] text-green">{c.connected}</span>}
              </h2>
              <p className="truncate text-[12px] text-muted">{github ? fill(c.githubConnected, { login: github.login }) : c.githubIdle}</p>
            </div>
          </div>
          {github ? (
            <button type="button" className="btn-secondary" onClick={() => setDisconnecting(true)}>
              {c.disconnect}
            </button>
          ) : (
            <form method="post" action="/api/auth/github/connect">
              <input type="hidden" name="returnTo" value="/settings?tab=connections" />
              <button type="submit" className="btn-secondary">
                <Icon name="github" />
                {c.connect}
              </button>
            </form>
          )}
        </div>
        <p className="mt-4 flex gap-2 rounded-lg bg-soft px-3 py-2.5 text-[12px] text-[#3b4361]">
          <Icon name="shield" className="mt-0.5 size-4 flex-none text-blue" />
          {c.githubNote}
        </p>
      </section>

      <section className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[17px] font-bold">{c.domains}</h2>
            <p className="mt-1 text-[12px] text-muted">{c.domainsBody}</p>
          </div>
          <button
            type="button"
            className="btn-secondary btn-sm"
            onClick={() => {
              setError('');
              setAdding(true);
            }}
          >
            <Icon name="plus" className="size-3.5" />
            {c.addDomain}
          </button>
        </div>
        <div className="mt-5 flex flex-col divide-y divide-line">
          {domains.length === 0 && <p className="text-[12px] text-muted">{c.noDomains}</p>}
          {domains.map((domain) => (
            <div key={domain.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <h3 className="truncate font-mono text-[13px] font-semibold">{domain.domain}</h3>
                <small className="text-[11px] text-muted">
                  {domain.method ? c.method[domain.method] : `${c.method.dns_txt} / ${c.method.well_known}`} · {c.shared}
                  {domain.checkedAt && domain.status !== 'verified' && ` · ${fill(c.lastChecked, { time: formatDateTime(domain.checkedAt, locale) })}`}
                </small>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`tag ${domain.status === 'verified' ? 'border-[#cfe8df] bg-[#e9f6f1] text-green' : 'border-[#f3e0c7] bg-[#fdf6ec] text-orange'}`}
                >
                  <Icon name={domain.status === 'verified' ? 'check' : 'clock'} className="size-3" />
                  {c.status[domain.status]}
                </span>
                {domain.status !== 'verified' && (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() => {
                      setError('');
                      setWizard({ domain, method: domain.method ?? 'dns_txt' });
                    }}
                  >
                    {c.continue}
                  </button>
                )}
                <button type="button" className="icon-btn" aria-label={c.remove} onClick={() => setRemoving(domain)}>
                  <Icon name="trash" />
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
        confirmLabel={c.remove}
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
            <button type="button" className="btn-secondary" onClick={() => setAdding(false)}>
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
          <label>
            <span className="field-label">{c.domainLabel}</span>
            <input className="input" value={name} placeholder="docs.example.com" maxLength={253} required autoFocus onChange={(event) => setName(event.target.value)} />
            <small className="hint">{c.domainHint}</small>
          </label>
          {error && (
            <p role="alert" className="mt-3 rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">
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
            <button type="button" className="btn-secondary" onClick={() => setWizard(null)}>
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
          <div className="flex flex-col gap-4">
            <p className="font-mono text-[13px] font-semibold break-all">{wizard.domain.domain}</p>
            <div className="flex rounded-lg border border-line bg-wash p-0.5" role="tablist">
              {(['dns_txt', 'well_known'] as const).map((method) => (
                <button
                  key={method}
                  type="button"
                  role="tab"
                  aria-selected={wizard.method === method}
                  onClick={() => setWizard({ ...wizard, method })}
                  className={`flex-1 rounded-md px-3 py-1.5 text-[12px] font-semibold ${wizard.method === method ? 'bg-white text-blue shadow-sm' : 'text-muted'}`}
                >
                  {c.method[method]}
                </button>
              ))}
            </div>
            <p className="text-[12px] text-muted">{wizard.method === 'dns_txt' ? c.dnsHint : c.fileHint}</p>
            <dl className="flex flex-col gap-2 rounded-lg border border-line bg-[#fbfcff] p-4 text-[12px]">
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
            <button type="button" className="btn-secondary w-full" onClick={() => copy(wizard.domain.challenge)}>
              <Icon name="copy" />
              {c.copy}
            </button>
            <p className="flex gap-2 rounded-lg bg-soft px-3 py-2.5 text-[11px] text-[#3b4361]">
              <Icon name="info" className="mt-0.5 size-3.5 flex-none text-blue" />
              {c.either}
            </p>
            {error && (
              <p role="alert" className="rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
