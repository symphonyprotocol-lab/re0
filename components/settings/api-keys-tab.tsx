'use client';

import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useState } from 'react';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDate, formatDateTime, formatNumber } from '@/i18n/format';
import { Spinner } from '@/components/ui/icons';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { I } from '@/components/settings/icon';

export interface ApiKeyView {
  id: string;
  name: string;
  tail: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** May change things through MCP (post, follow up, manage Rees), not only read and ask. */
  canWrite: boolean;
  /** A workspace key reaches only the agent workspace's files, under its root. */
  kind: 'account' | 'workspace';
  workspaceAccess: 'none' | 'read' | 'write';
  workspaceRoot: string;
  /** The MCP client that last connected with it, as it named itself. */
  client: string | null;
  questions: number;
  spent: number;
}

const EXPIRIES = [
  ['never', null],
  ['d30', 30],
  ['d90', 90],
  ['d365', 365],
] as const;

const PLACEHOLDER = 're0_sk_…';

function statusOf(key: ApiKeyView, now: number): 'active' | 'expired' | 'revoked' {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

/** The `claude mcp add` line and a JSON config for other clients, with the key or a placeholder. */
export function connectSnippets(url: string, secret: string) {
  return {
    claude: `claude mcp add --transport http re0 ${url} --header "Authorization: Bearer ${secret}"`,
    json: JSON.stringify({ mcpServers: { re0: { type: 'http', url, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2),
  };
}

/**
 * `/settings?tab=api`: API keys for the MCP server -- create one (name,
 * optional expiry, whether it may change things; the key is shown once),
 * see each one's tail, access, dates and usage, revoke -- and how to
 * connect a client. A key's access is chosen once: more needs a new key.
 */
export function ApiKeysTab({ keys: initialKeys, mcpUrl }: { keys: ApiKeyView[]; mcpUrl: string }) {
  const { t, locale } = useI18n();
  const a = t.apiKeys;
  const router = useRouter();
  const toast = useToast();
  const [keys, setKeys] = useState(initialKeys);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<(typeof EXPIRIES)[number][0]>('never');
  const [canWrite, setCanWrite] = useState(false);
  const [kind, setKind] = useState<'workspace' | 'account'>('workspace');
  const [access, setAccess] = useState<'none' | 'read' | 'write'>('write');
  const [root, setRoot] = useState('/');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyView | null>(null);
  const [now] = useState(() => Date.now());

  const reload = async () => {
    const result = await api<{ items: ApiKeyView[] }>('/api/account/api-keys');
    if (result.ok) setKeys(result.data.items);
  };

  const create = async () => {
    setError('');
    setBusy(true);
    const days = EXPIRIES.find(([value]) => value === expiry)![1];
    const result = await api<{ secret?: string; error?: string }>('/api/account/api-keys', { method: 'POST', json: { name, expiresInDays: days, canWrite: kind === 'account' && canWrite, kind, workspaceAccess: access, workspaceRoot: root } });
    setBusy(false);
    if (!result.ok || !result.data.secret) {
      const code = result.data.error as keyof typeof a.errors | undefined;
      return setError(code && code in a.errors ? a.errors[code] : t.common.errors.generic);
    }
    setCreating(false);
    setName('');
    setExpiry('never');
    setCanWrite(false);
    setKind('workspace');
    setAccess('write');
    setRoot('/');
    setSecret(result.data.secret);
    await reload();
  };

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value).then(() => toast(a.created.copied), () => toast(t.common.errors.generic));
  };

  const snippets = connectSnippets(mcpUrl, PLACEHOLDER);
  const fresh = secret ? connectSnippets(mcpUrl, secret) : null;

  return (
    <>
      <section className="card settings-card">
        <div className="between">
          <div>
            <h2>{a.title}</h2>
            <p className="muted small domains-lede">{a.lede}</p>
          </div>
          <button
            type="button"
            className="btn secondary sm"
            onClick={() => {
              setError('');
              setCreating(true);
            }}
          >
            <I name="plus" />
            {a.create}
          </button>
        </div>
        <div className="info-strip mt16">
          <I name="wallet" />
          <span>{a.spendNote}</span>
        </div>
        <div className="mt24">
          {keys.length === 0 && <p className="small muted">{a.empty}</p>}
          {keys.map((key) => {
            const status = statusOf(key, now);
            return (
              <div key={key.id} className="domain-row api-key-row">
                <div className="min-w-0">
                  <h3>
                    {key.name} <span className="api-key-tail">re0_sk_…{key.tail}</span>{' '}
                    {key.kind === 'workspace' ? (
                      <>
                        <span className="tag blue api-key-access">{a.kinds.workspace}</span>{' '}
                        <span className={`tag ${key.workspaceAccess === 'write' ? 'orange' : ''} api-key-access`}>{a.workspaceAccess[key.workspaceAccess]}</span>{' '}
                        <span className="tag api-key-access">{key.workspaceRoot}</span>
                      </>
                    ) : (
                      <>
                        <span className={`tag ${key.canWrite ? 'orange' : ''} api-key-access`}>{key.canWrite ? a.access.write : a.access.read}</span>{' '}
                        <span className="tag api-key-access">{fill(a.workspaceTag, { access: a.workspaceAccess[key.workspaceAccess] })}</span>
                      </>
                    )}
                  </h3>
                  <small>
                    {a.columns.created} {formatDateTime(key.createdAt, locale)} · {a.columns.lastUsed} {key.lastUsedAt ? formatDateTime(key.lastUsedAt, locale) : a.never} ·{' '}
                    {key.expiresAt ? fill(a.expires, { date: formatDate(key.expiresAt, locale) }) : a.noExpiry}
                  </small>
                  <small className="api-key-usage">{fill(a.usage, { questions: formatNumber(key.questions, locale), spent: formatNumber(key.spent, locale) })}</small>
                </div>
                <div className="s-flex flex-none">
                  <span className={`tag ${status === 'active' ? 'green' : status === 'revoked' ? 'red' : 'orange'}`}>{a.status[status]}</span>
                  {status !== 'revoked' && (
                    <button type="button" className="btn secondary sm" onClick={() => setRevoking(key)}>
                      {a.revoke}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card settings-card">
        <h2>{a.connect.title}</h2>
        <p className="muted">{a.connect.body}</p>
        <div className="field mt16">
          <span className="field-label">{a.connect.url}</span>
          <div className="code-block api-key-snippet">
            <code>{mcpUrl}</code>
            <button type="button" className="icon-btn" aria-label={a.connect.copy} title={a.connect.copy} onClick={() => copy(mcpUrl)}>
              <I name="copy" />
            </button>
          </div>
        </div>
        <div className="field">
          <span className="field-label">{a.connect.claude}</span>
          <div className="code-block api-key-snippet">
            <code>{snippets.claude}</code>
            <button type="button" className="icon-btn" aria-label={a.connect.copy} title={a.connect.copy} onClick={() => copy(snippets.claude)}>
              <I name="copy" />
            </button>
          </div>
        </div>
        <div className="field">
          <span className="field-label">{a.connect.json}</span>
          <div className="code-block api-key-snippet">
            <code>{snippets.json}</code>
            <button type="button" className="icon-btn" aria-label={a.connect.copy} title={a.connect.copy} onClick={() => copy(snippets.json)}>
              <I name="copy" />
            </button>
          </div>
        </div>
        <p className="small muted">{a.connect.tools}</p>
        <div className="info-strip mt16">
          <I name="info" />
          <span>{a.connect.docs}</span>
        </div>
      </section>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={a.form.title}
        subtitle={a.form.subtitle}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setCreating(false)}>
              {t.common.actions.cancel}
            </button>
            <button type="submit" form="api-key-form" className="btn" disabled={busy}>
              {busy && <Spinner />}
              {a.form.submit}
            </button>
          </>
        }
      >
        <form
          id="api-key-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="api-key-kinds" role="radiogroup" aria-label={a.form.kind}>
            {(['workspace', 'account'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={kind === value}
                className={kind === value ? 'is-on' : undefined}
                onClick={() => {
                  setKind(value);
                  setAccess(value === 'workspace' ? 'write' : 'none');
                }}
              >
                <I name={value === 'workspace' ? 'folder' : 'key'} />
                <strong>{a.kinds[value]}</strong>
                <small>{a.kindHints[value]}</small>
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="api-key-name">{a.form.name}</label>
            <input id="api-key-name" value={name} placeholder={a.form.namePlaceholder} maxLength={60} required autoFocus onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="api-key-expiry">{a.form.expiry}</label>
            <select id="api-key-expiry" value={expiry} onChange={(event) => setExpiry(event.target.value as typeof expiry)}>
              {EXPIRIES.map(([value]) => (
                <option key={value} value={value}>
                  {a.form.expiryOptions[value]}
                </option>
              ))}
            </select>
          </div>
          {kind === 'workspace' && (
            <div className="field">
              <label htmlFor="api-key-root">{a.form.root}</label>
              <input id="api-key-root" className="mono" value={root} maxLength={1024} onChange={(event) => setRoot(event.target.value)} />
              <p className="form-hint">{a.form.rootHint}</p>
            </div>
          )}
          {kind === 'account' && (
            <label className="check-row api-key-write">
              <span>
                <strong>{a.form.write}</strong>
                <small>{a.form.writeHint}</small>
              </span>
              <input type="checkbox" checked={canWrite} onChange={(event) => setCanWrite(event.target.checked)} />
            </label>
          )}
          <div className="field">
            <span className="field-label">{a.form.workspace}</span>
            <div className="api-key-access-options" role="radiogroup" aria-label={a.form.workspace}>
              {(kind === 'workspace' ? (['read', 'write'] as const) : (['none', 'read', 'write'] as const)).map((value) => (
                <label key={value} className={access === value ? 'is-on' : undefined}>
                  <input type="radio" name="api-key-workspace" checked={access === value} onChange={() => setAccess(value)} />
                  <span>
                    <strong>{a.workspaceAccess[value]}</strong>
                    <small>{a.workspaceAccessHints[value]}</small>
                  </span>
                </label>
              ))}
            </div>
            <p className="form-hint">{kind === 'workspace' ? a.form.workspaceKeyHint : a.form.workspaceHint}</p>
          </div>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </form>
      </Modal>

      <Modal
        open={Boolean(secret)}
        onClose={() => setSecret(null)}
        dismissible={false}
        title={a.created.title}
        subtitle={a.created.body}
        footer={
          <button type="button" className="btn" onClick={() => setSecret(null)}>
            {a.created.done}
          </button>
        }
      >
        {secret && fresh && (
          <div>
            <div className="code-block api-key-snippet">
              <code>{secret}</code>
            </div>
            <button type="button" className="btn secondary full mt16" onClick={() => copy(secret)}>
              <I name="copy" />
              {a.created.copy}
            </button>
            <p className="field-label mt16">{a.connect.claude}</p>
            <div className="code-block api-key-snippet api-key-gap">
              <code>{fresh.claude}</code>
              <button type="button" className="icon-btn" aria-label={a.connect.copy} title={a.connect.copy} onClick={() => copy(fresh.claude)}>
                <I name="copy" />
              </button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={Boolean(revoking)}
        title={a.revokeTitle}
        body={revoking ? fill(a.revokeBody, { name: revoking.name }) : ''}
        confirmLabel={a.revoke}
        danger
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          const key = revoking!;
          setRevoking(null);
          const result = await api(`/api/account/api-keys/${key.id}`, { method: 'DELETE' });
          if (!result.ok) return toast(t.common.errors.generic);
          toast(a.revoked);
          await reload();
          router.refresh();
        }}
      />
    </>
  );
}
