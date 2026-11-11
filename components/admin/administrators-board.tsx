'use client';

import { useState } from 'react';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { ConfirmModal, Modal } from '@/components/admin/console-modal';
import { Clip, PageHead, Person, RecordSection, RecordsTable, SummaryCards, Tag } from '@/components/admin/list-kit';
import { useToast } from '@/components/ui/toast';
import type { AdministratorRow } from '@/lib/services/admin-administrators';

/** `AdministratorRow` as it crosses to the browser: the date as an ISO string. */
export type AdministratorItem = Omit<AdministratorRow, 'createdAt'> & { createdAt: string };

const STATUS_TONES = { active: 'green', invited: 'orange', disabled: 'red' } as const;
const STATUSES = ['active', 'invited', 'disabled'] as const;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * The console's administrators page (2.5, prototype `manage-admins`): every
 * administrator with role, status and who added them; disable another one
 * (never yourself or the owner); copy a pending invitee's enrolment link
 * again; add one, which answers a one-time enrolment link to hand over --
 * nothing is emailed. Only the owner sees these actions (the server refuses
 * anyone else); an inviter may still copy their own invitee's link. The server renders the first list; every change
 * reloads it from `/api/admin/administrators`.
 */
export function AdministratorsBoard({ initial, self, owner, selfEmail }: { initial: AdministratorItem[]; self: string; owner: boolean; selfEmail: string }) {
  const { t, locale } = useI18n();
  const a = t.consoleRees.administrators;
  const toast = useToast();
  const [items, setItems] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [disabling, setDisabling] = useState<AdministratorItem | null>(null);
  const [created, setCreated] = useState<{ email: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const message = (code: string | undefined) => (code && code in a.errors ? a.errors[code as keyof typeof a.errors] : t.common.errors.generic);

  const load = async () => {
    const result = await api<{ items: AdministratorItem[]; self: string }>('/api/admin/administrators', { cache: 'no-store' }).catch(() => null);
    if (!result?.ok) return setError(a.loadFailed);
    setItems(result.data.items);
  };

  const showLink = (email: string, link: string) => {
    setCopied(false);
    setCreated({ email, link });
  };

  /* A thrown request (network down) answers null, so `busy` is always released and the generic error shows. */
  const disable = async (item: AdministratorItem) => {
    setBusy(item.id);
    setError('');
    const result = await api<{ error?: string }>(`/api/admin/administrators/${item.id}`, { method: 'POST', json: { action: 'disable' } }).catch(() => null);
    setBusy('');
    setDisabling(null);
    if (!result?.ok) setError(message(result?.data.error));
    await load();
  };

  const copyLink = async (item: AdministratorItem) => {
    setBusy(item.id);
    setError('');
    const result = await api<{ link?: string; error?: string }>(`/api/admin/administrators/${item.id}`, { method: 'POST', json: { action: 'link' } }).catch(() => null);
    setBusy('');
    if (!result?.ok || !result.data.link) {
      setError(message(result?.data.error));
      return load();
    }
    if (await copyText(result.data.link)) toast(a.linkCopied);
    else showLink(item.email, result.data.link);
  };

  const add = async (formElement: HTMLFormElement) => {
    const form = new FormData(formElement);
    const email = String(form.get('email') ?? '').trim();
    setBusy('add');
    setError('');
    setAddError('');
    const result = await api<{ link?: string; error?: string }>('/api/admin/administrators', {
      method: 'POST',
      json: { name: String(form.get('name') ?? '').trim(), email },
    }).catch(() => null);
    setBusy('');
    if (!result?.ok || !result.data.link) return setAddError(message(result?.data.error));
    formElement.reset();
    setAdding(false);
    showLink(email, result.data.link);
    void load();
  };

  const rows = items.map((item) => [
    <Person
      key="person"
      name={item.id === self ? `${item.name} (${t.console.administrators.you})` : item.name}
      email={item.email}
    />,
    <span key="role" className="tag">
      {a.roles[item.role]}
    </span>,
    <Tag key="status" tone={STATUS_TONES[item.status]}>
      {a.status[item.status]}
    </Tag>,
    <span key="created" className="mono">
      {formatDateTime(item.createdAt, locale)}
    </span>,
    <Clip key="by" value={item.createdBy} />,
    <div key="actions" className="flex">
      {item.status === 'invited' && (owner || item.createdBy === selfEmail) && (
        <button type="button" className="btn ghost sm" onClick={() => void copyLink(item)} disabled={busy === item.id}>
          <CI name="copy" />
          {a.copyLink}
        </button>
      )}
      {owner && item.status !== 'disabled' && item.role !== 'owner' && item.id !== self && (
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            setError('');
            setDisabling(item);
          }}
          disabled={busy === item.id}
        >
          {a.disable}
        </button>
      )}
    </div>,
  ]);

  return (
    <>
      <PageHead
        title={a.title}
        lede={a.lede}
        actions={
          owner && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setAddError('');
                setAdding(true);
              }}
            >
              <CI name="plus" />
              {a.add}
            </button>
          )
        }
      />
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <SummaryCards
        label={a.title}
        items={[
          { label: a.cards.all, value: formatNumber(items.length, locale) },
          ...STATUSES.map((status) => ({ label: a.status[status], value: formatNumber(items.filter((item) => item.status === status).length, locale) })),
        ]}
      />
      <RecordSection className="administrators-records">
        <RecordsTable
          label={a.tableLabel}
          empty={a.empty}
          head={[a.columns.administrator, a.columns.role, a.columns.status, a.columns.createdAt, a.columns.createdBy, a.columns.actions]}
          rows={rows}
        />
      </RecordSection>
      <Modal
        open={adding}
        onClose={() => busy !== 'add' && setAdding(false)}
        title={a.add}
        subtitle={a.subtitle}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setAdding(false)} disabled={busy === 'add'}>
              {t.common.actions.cancel}
            </button>
            <button type="submit" form="add-admin-form" className="btn" disabled={busy === 'add'}>
              {a.submit}
            </button>
          </>
        }
      >
        <form
          id="add-admin-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add(event.currentTarget);
          }}
        >
          {addError && (
            <div className="form-error" role="alert">
              {addError}
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
      </Modal>
      <Modal
        open={Boolean(created)}
        onClose={() => setCreated(null)}
        title={a.linkTitle}
        footer={
          <button type="button" className="btn" onClick={() => setCreated(null)}>
            {a.done}
          </button>
        }
      >
        {created && (
          <div>
            <p className="form-hint">{fill(a.linkNote, { email: created.email })}</p>
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
        onConfirm={() => disabling && void disable(disabling)}
      />
    </>
  );
}
