'use client';

import { useState } from 'react';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { ConfirmModal, Modal } from '@/components/ui/modal';

interface AdministratorItem {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'administrator';
  status: 'active' | 'invited' | 'disabled';
  createdAt: string;
  createdBy: string | null;
}

const STATUS_TONES = {
  active: 'border-[#cde8df] bg-[#effaf6] text-green',
  invited: 'border-[#f0dcc2] bg-[#fff7ec] text-orange',
  disabled: 'border-[#f1d4d4] bg-[#fff3f3] text-red',
} as const;

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
      <button type="button" className="btn-secondary btn-sm" aria-label={t.console.nav.administrators} onClick={show}>
        <Icon name="user" className="size-3.5" />
        <span className="hidden sm:inline">{t.console.nav.administrators}</span>
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
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
                {t.common.actions.close}
              </button>
              <button type="submit" form="add-admin-form" className="btn" disabled={busy === 'add'}>
                {busy === 'add' && <Spinner />}
                {a.submit}
              </button>
            </>
          )
        }
      >
        {created ? (
          <div>
            <h3 className="text-[14px] font-bold">{a.linkTitle}</h3>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{fill(a.linkNote, { email: created.email })}</p>
            <code className="mt-3 block max-h-32 overflow-y-auto rounded-lg border border-line bg-wash p-3 font-mono text-[11px] break-all select-all">{created.link}</code>
            <button
              type="button"
              className="btn-secondary btn-sm mt-3"
              onClick={async () => {
                if (await copyText(created.link)) setCopied(true);
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} className="size-3.5" />
              {copied ? a.copied : a.copy}
            </button>
          </div>
        ) : (
          <>
            {items === null && !loadError && (
              <p className="flex items-center gap-2 text-[12px] text-muted">
                <Spinner className="size-3.5" />
                {a.loading}
              </p>
            )}
            {loadError && (
              <p role="alert" className="text-[12px] text-red">
                {a.loadFailed}
              </p>
            )}
            {items && (
              <ul className="divide-y divide-line">
                {items.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 py-3 first:pt-0">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
                        <span className="min-w-0 break-words">{item.name}</span>
                        {item.id === self && <span className="text-[11px] font-normal text-muted">({a.you})</span>}
                      </p>
                      <p className="text-[12px] break-all text-muted">{item.email}</p>
                      <p className="mt-0.5 text-[11px] text-muted">{formatDateTime(item.createdAt, locale)}</p>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <span className={`tag ${item.role === 'owner' ? 'border-[#cfe1fb] bg-soft text-blue' : ''}`}>{a.roles[item.role]}</span>
                      <span className={`tag ${STATUS_TONES[item.status]}`}>{a.status[item.status]}</span>
                      {item.status === 'invited' && (
                        <button type="button" className="btn-ghost btn-sm" onClick={() => copyLink(item)} disabled={busy === item.id}>
                          {busy === item.id ? <Spinner className="size-3" /> : <Icon name={copiedId === item.id ? 'check' : 'copy'} className="size-3.5" />}
                          {copiedId === item.id ? a.linkCopied : a.copyLink}
                        </button>
                      )}
                      {item.status !== 'disabled' && item.role !== 'owner' && item.id !== self && (
                        <button type="button" className="btn-ghost btn-sm text-red" onClick={() => setDisabling(item)} disabled={busy === item.id}>
                          {a.disable}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {error && (
              <p role="alert" className="mt-3 text-[12px] text-red">
                {error}
              </p>
            )}
            <form
              id="add-admin-form"
              className="mt-4 border-t border-line pt-4"
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
              <h3 className="text-[14px] font-bold">{a.add}</h3>
              <label htmlFor="new-admin-name" className="field-label mt-3">
                {a.name}
              </label>
              <input id="new-admin-name" name="name" required maxLength={40} className="input" autoComplete="off" />
              <label htmlFor="new-admin-email" className="field-label mt-3">
                {a.email}
              </label>
              <input id="new-admin-email" name="email" type="email" required maxLength={254} className="input" placeholder="colleague@example.com" autoComplete="off" />
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
