'use client';

import { useState } from 'react';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { ConfirmModal, Modal } from '@/components/admin/console-modal';
import { Tag } from '@/components/admin/list-kit';

interface AdministratorItem {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'administrator';
  status: 'active' | 'invited' | 'disabled';
  createdAt: string;
  createdBy: string | null;
}

const STATUS_TONES = { active: 'green', invited: 'orange', disabled: 'red' } as const;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The top bar's "管理员" button and its dialog (2.5, prototype
 * `manage-admins`): every administrator with role and status; disable
 * another one (never yourself or the owner); add one, which answers a
 * one-time enrolment link to hand over -- nothing is emailed.
 */
export function AdministratorsButton() {
  const { t, locale } = useI18n();
  const a = t.consoleRees.administrators;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AdministratorItem[] | null>(null);
  const [self, setSelf] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [disabling, setDisabling] = useState<AdministratorItem | null>(null);
  const [created, setCreated] = useState<{ email: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedId, setCopiedId] = useState('');

  const message = (code: string | undefined) => (code && code in a.errors ? a.errors[code as keyof typeof a.errors] : t.common.errors.generic);

  const load = async () => {
    setLoadError(false);
    const result = await api<{ items: AdministratorItem[]; self: string }>('/api/admin/administrators', { cache: 'no-store' }).catch(() => null);
    if (!result?.ok) return setLoadError(true);
    setItems(result.data.items);
    setSelf(result.data.self);
  };

  const show = () => {
    setError('');
    setCreated(null);
    setCopied(false);
    setCopiedId('');
    setOpen(true);
    void load();
  };

  const disable = async (item: AdministratorItem) => {
    setBusy(item.id);
    setError('');
    const result = await api<{ error?: string }>(`/api/admin/administrators/${item.id}`, { method: 'POST', json: { action: 'disable' } });
    setBusy('');
    setDisabling(null);
    if (!result.ok) setError(message(result.data.error));
    await load();
  };

  const copyLink = async (item: AdministratorItem) => {
    setBusy(item.id);
    setError('');
    const result = await api<{ link?: string; error?: string }>(`/api/admin/administrators/${item.id}`, { method: 'POST', json: { action: 'link' } });
    setBusy('');
    if (!result.ok || !result.data.link) {
      setError(message(result.data.error));
      return load();
    }
    /* The dialog sits in the top layer, so the confirmation shows on the row rather than as a toast. */
    if (await copyText(result.data.link)) setCopiedId(item.id);
    else setCreated({ email: item.email, link: result.data.link });
  };

  return (
    <>
      <button type="button" className="btn secondary sm" aria-label={t.console.nav.administrators} onClick={show}>
        <CI name="users" />
        <span className="admin-manage-label">{t.console.nav.administrators}</span>
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={a.title}
        subtitle={a.subtitle}
        footer={
          created ? (
            <button type="button" className="btn" onClick={() => setCreated(null)}>
              {a.done}
            </button>
          ) : (
            <>
              <button type="button" className="btn secondary" onClick={() => setOpen(false)}>
                {t.common.actions.close}
              </button>
              <button type="submit" form="add-admin-form" className="btn" disabled={busy === 'add'}>
                {a.submit}
              </button>
            </>
          )
        }
      >
        {created ? (
          <div>
            <h3>{a.linkTitle}</h3>
            <p className="form-hint mt16">{fill(a.linkNote, { email: created.email })}</p>
            <code className="code-block mt16" style={{ display: 'block', userSelect: 'all' }}>
              {created.link}
            </code>
            <button
              type="button"
              className="btn secondary sm mt16"
              onClick={async () => {
                if (await copyText(created.link)) setCopied(true);
              }}
            >
              <CI name={copied ? 'check' : 'copy'} />
              {copied ? a.copied : a.copy}
            </button>
          </div>
        ) : (
          <>
            {items === null && !loadError && (
              <p className="form-hint">
                <span className="spinner" aria-hidden="true" /> {a.loading}
              </p>
            )}
            {loadError && (
              <div className="form-error" role="alert">
                {a.loadFailed}
              </div>
            )}
            {items?.map((item) => (
              <div key={item.id} className="settings-row">
                <div>
                  <h3>
                    {item.name}
                    {item.id === self && <span className="muted"> ({t.console.administrators.you})</span>}
                  </h3>
                  <p>
                    {item.email} · {formatDateTime(item.createdAt, locale)}
                  </p>
                </div>
                <div className="flex">
                  <span className="tag">{a.roles[item.role]}</span>
                  <Tag tone={STATUS_TONES[item.status]}>{a.status[item.status]}</Tag>
                  {item.status === 'invited' && (
                    <button type="button" className="btn ghost sm" onClick={() => copyLink(item)} disabled={busy === item.id}>
                      <CI name={copiedId === item.id ? 'check' : 'copy'} />
                      {copiedId === item.id ? a.linkCopied : a.copyLink}
                    </button>
                  )}
                  {item.status !== 'disabled' && item.role !== 'owner' && item.id !== self && (
                    <button type="button" className="btn ghost sm" onClick={() => setDisabling(item)} disabled={busy === item.id}>
                      {a.disable}
                    </button>
                  )}
                </div>
              </div>
            ))}
            <div className="rule" />
            <form
              id="add-admin-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const formElement = event.currentTarget;
                const form = new FormData(formElement);
                const email = String(form.get('email') ?? '').trim();
                setBusy('add');
                setError('');
                const result = await api<{ link?: string; error?: string }>('/api/admin/administrators', {
                  method: 'POST',
                  json: { name: String(form.get('name') ?? '').trim(), email },
                });
                setBusy('');
                if (!result.ok || !result.data.link) return setError(message(result.data.error));
                formElement.reset();
                setCopied(false);
                setCreated({ email, link: result.data.link });
                void load();
              }}
            >
              {error && (
                <div className="form-error" role="alert">
                  {error}
                </div>
              )}
              <div className="field">
                <label htmlFor="new-admin-name">{a.name}</label>
                <input id="new-admin-name" name="name" required maxLength={40} autoComplete="off" />
              </div>
              <div className="field">
                <label htmlFor="new-admin-email">{a.email}</label>
                <input id="new-admin-email" name="email" type="email" required maxLength={254} placeholder="colleague@example.com" autoComplete="off" />
              </div>
              <div className="demo-label">{t.console.administrators.inviteNote}</div>
            </form>
          </>
        )}
      </Modal>
      <ConfirmModal
        open={Boolean(disabling)}
        title={fill(a.disableTitle, { name: disabling?.name ?? '' })}
        body={a.disableBody}
        confirmLabel={a.disable}
        danger
        busy={Boolean(disabling && busy === disabling.id)}
        onClose={() => setDisabling(null)}
        onConfirm={() => disabling && disable(disabling)}
      />
    </>
  );
}
