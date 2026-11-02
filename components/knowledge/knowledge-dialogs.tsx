'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { KNOWLEDGE_FOLDER_NAME_MAX, KNOWLEDGE_TITLE_MAX } from '@/lib/constants';
import { holdFor, type KnowledgeKind } from '@/lib/domain/knowledge';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { errorText, KIND_ICONS } from '@/components/knowledge/shared';

/** What an action needs to know about a source: enough to list it, check it, and price a reprocess. */
export interface ActionItem {
  id: string;
  title: string;
  kind: KnowledgeKind;
  status: string;
  enabled: boolean;
  folderId: string | null;
  fileSize: number | null;
  chars: number;
  deletedAt: string | Date | null;
}

export type BulkAction = 'pause' | 'resume' | 'trash' | 'reprocess' | 'restore';

export type Dialog =
  | { type: 'menu'; item: ActionItem }
  | { type: 'move'; items: ActionItem[] }
  | { type: 'rename'; item: ActionItem }
  | { type: 'confirm'; action: BulkAction; items: ActionItem[] };

export const isBusy = (item: { status: string }) => item.status === 'pending' || item.status === 'processing';

/** What reprocessing one source reserves (8.2): its kind's cap, text by length, audio by size. */
export function reprocessCost(item: Pick<ActionItem, 'kind' | 'chars' | 'fileSize'>): number {
  if (item.kind === 'text') return holdFor('text', 'x'.repeat(item.chars));
  if (item.kind === 'audio') return holdFor('audio', item.fileSize ?? 0);
  return holdFor(item.kind);
}

export function SelectionReview({ items }: { items: ActionItem[] }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-wash p-3 text-[12px]">
      {items.slice(0, 5).map((item) => (
        <p key={item.id} className="flex min-w-0 items-center gap-2">
          <Icon name={KIND_ICONS[item.kind]} className="size-3.5 flex-none text-blue" />
          <span className="truncate">{item.title}</span>
        </p>
      ))}
      {items.length > 5 && <small className="text-muted">{fill(t.knowledge.selection.andMore, { n: items.length - 5 })}</small>}
    </div>
  );
}

/**
 * The dialogs the library and the preview share: a source's menu, moving,
 * renaming, and the confirmations before a batch. Each runs its request
 * and reports back with a message to toast.
 */
export function KnowledgeDialogs({
  reeId,
  dialog,
  folders,
  onOpen,
  onClose,
  onDone,
  onPreview,
}: {
  reeId: string;
  dialog: Dialog | null;
  /** Known folders; fetched when moving if not given. */
  folders?: { id: string; name: string }[];
  onOpen: (next: Dialog) => void;
  onClose: () => void;
  onDone: (message: string) => void;
  onPreview?: (item: ActionItem) => void;
}) {
  const { t, locale } = useI18n();
  const k = t.knowledge;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('unfiled');
  const [newName, setNewName] = useState('');
  const [known, setKnown] = useState<{ id: string; name: string }[]>(folders ?? []);

  useEffect(() => {
    setError(null);
    setBusy(false);
    if (dialog?.type === 'rename') setTitle(dialog.item.title);
    if (dialog?.type === 'move') {
      const current = [...new Set(dialog.items.map((item) => item.folderId ?? 'unfiled'))];
      setTarget(current.length === 1 ? current[0]! : 'unfiled');
      setNewName('');
      if (folders) setKnown(folders);
      else void api<{ items: { id: string; name: string }[] }>(`/api/rees/${reeId}/folders`).then((result) => result.ok && setKnown(result.data.items));
    }
  }, [dialog, folders, reeId]);

  const fail = (code: string | undefined, status: number) => setError({ text: status === 402 ? k.errors.insufficient_credits : errorText(t, code), code: status === 402 ? 'insufficient_credits' : code });

  const batch = async (action: string, items: ActionItem[], extra: Record<string, unknown> = {}) => {
    setBusy(true);
    const result = await api<{ changed?: number; folder?: { name: string } | null; error?: string }>(`/api/rees/${reeId}/knowledge/batch`, {
      method: 'POST',
      json: { action, ids: items.map((item) => item.id), ...extra },
    });
    setBusy(false);
    if (!result.ok) {
      fail(result.data.error, result.status);
      return null;
    }
    return result.data;
  };

  const confirm = async (action: BulkAction, items: ActionItem[]) => {
    const result = await batch(action, items);
    if (!result) return;
    const n = items.length;
    onDone(
      action === 'trash' ? k.done.trashed : action === 'restore' ? fill(k.done.restored, { n }) : action === 'reprocess' ? fill(k.done.reprocess, { n }) : fill(k.done.scope, { n }),
    );
  };

  const folderName = (id: string | null) => (id ? (known.find((folder) => folder.id === id)?.name ?? k.folders.unfiled) : k.folders.unfiled);
  const errorBox = error && (
    <p role="alert" className="mt-3 rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">
      {error.text}{' '}
      {error.code === 'insufficient_credits' && (
        <Link href="/settings?tab=billing" className="font-semibold underline">
          {t.chat.insufficient.topUp}
        </Link>
      )}
      {(error.code === 'github_not_connected' || error.code === 'domain_unverified') && (
        <Link href="/settings?tab=connections" className="font-semibold underline">
          {error.code === 'github_not_connected' ? k.addModal.connect : k.addModal.verify}
        </Link>
      )}
    </p>
  );
  const cancel = (
    <button type="button" className="btn-secondary" onClick={onClose}>
      {t.common.actions.cancel}
    </button>
  );

  if (!dialog) return null;

  if (dialog.type === 'menu') {
    const item = dialog.item;
    const trash = Boolean(item.deletedAt);
    const entry = (icon: Parameters<typeof Icon>[0]['name'], label: string, run: () => void, options: { danger?: boolean; disabled?: boolean } = {}) => (
      <button
        type="button"
        disabled={options.disabled}
        onClick={run}
        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium hover:bg-wash disabled:opacity-40 ${options.danger ? 'text-red' : ''}`}
      >
        <Icon name={icon} className="size-4" />
        {label}
      </button>
    );
    return (
      <Modal open onClose={onClose} title={item.title} subtitle={t.common.kinds[item.kind]}>
        <div className="flex flex-col gap-0.5">
          {onPreview && entry('external', k.menu.preview, () => onPreview(item))}
          {trash ? (
            entry('refresh', k.menu.restore, () => onOpen({ type: 'confirm', action: 'restore', items: [item] }))
          ) : (
            <>
              {entry('folder', k.menu.move, () => onOpen({ type: 'move', items: [item] }))}
              {entry('settings', k.menu.rename, () => onOpen({ type: 'rename', item }))}
              {entry(item.enabled ? 'pause' : 'play', item.enabled ? k.menu.pause : k.menu.enable, () => void confirm(item.enabled ? 'pause' : 'resume', [item]))}
              {entry('refresh', fill(k.menu.reprocess, { credits: formatNumber(reprocessCost(item), locale) }), () => onOpen({ type: 'confirm', action: 'reprocess', items: [item] }), { disabled: isBusy(item) })}
              {entry('trash', k.menu.trash, () => onOpen({ type: 'confirm', action: 'trash', items: [item] }), { danger: true, disabled: isBusy(item) })}
            </>
          )}
        </div>
        {errorBox}
      </Modal>
    );
  }

  if (dialog.type === 'rename') {
    return (
      <Modal
        open
        onClose={onClose}
        title={k.rename.title}
        subtitle={k.rename.subtitle}
        footer={
          <>
            {cancel}
            <button type="submit" form="knowledge-rename-form" className="btn" disabled={busy}>
              {busy && <Spinner />}
              {k.rename.submit}
            </button>
          </>
        }
      >
        <form
          id="knowledge-rename-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!title.trim()) return setError({ text: k.errors.invalid_title });
            setBusy(true);
            const result = await api<{ error?: string }>(`/api/rees/${reeId}/knowledge/${dialog.item.id}`, { method: 'PATCH', json: { title } });
            setBusy(false);
            if (!result.ok) return fail(result.data.error, result.status);
            onDone(k.done.renamed);
          }}
        >
          <label>
            <span className="field-label">{k.rename.label}</span>
            <input className="input" value={title} maxLength={KNOWLEDGE_TITLE_MAX} required autoFocus onChange={(event) => setTitle(event.target.value)} />
          </label>
        </form>
        {errorBox}
      </Modal>
    );
  }

  if (dialog.type === 'move') {
    const items = dialog.items;
    const current = [...new Set(items.map((item) => item.folderId ?? null))];
    return (
      <Modal
        open
        onClose={onClose}
        title={fill(k.move.title, { n: items.length })}
        subtitle={k.move.subtitle}
        footer={
          <>
            {cancel}
            <button type="submit" form="knowledge-move-form" className="btn" disabled={busy}>
              {busy && <Spinner />}
              {k.move.submit}
            </button>
          </>
        }
      >
        <SelectionReview items={items} />
        <form
          id="knowledge-move-form"
          className="mt-4 flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            const extra = target === 'new' ? { newFolderName: newName } : { folderId: target === 'unfiled' ? null : target };
            const result = await batch('move', items, extra);
            if (!result) return;
            const name = result.folder?.name ?? k.folders.unfiled;
            onDone(result.changed ? fill(k.done.moved, { n: result.changed, folder: name }) : k.done.alreadyThere);
          }}
        >
          <label>
            <span className="field-label">{k.move.target}</span>
            <select className="input" value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="unfiled">{k.folders.unfiled}</option>
              {known.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
              <option value="new">{k.move.newFolder}</option>
            </select>
          </label>
          {target === 'new' && (
            <label>
              <span className="field-label">{k.move.newName}</span>
              <input className="input" value={newName} maxLength={KNOWLEDGE_FOLDER_NAME_MAX} required autoFocus onChange={(event) => setNewName(event.target.value)} />
            </label>
          )}
          <p className="text-[11px] text-muted">{fill(k.move.current, { folders: current.map(folderName).join('、') })}</p>
        </form>
        {errorBox}
      </Modal>
    );
  }

  const { action, items } = dialog;
  const titles: Record<BulkAction, string> = {
    pause: k.confirm.pauseTitle,
    resume: k.confirm.enableTitle,
    trash: fill(k.confirm.trashTitle, { n: items.length }),
    reprocess: fill(k.confirm.reprocessTitle, { n: items.length }),
    restore: fill(k.confirm.restoreTitle, { n: items.length }),
  };
  const labels: Record<BulkAction, string> = {
    pause: k.confirm.confirm,
    resume: k.confirm.confirm,
    trash: k.confirm.trashConfirm,
    reprocess: k.confirm.reprocessConfirm,
    restore: k.menu.restore,
  };
  const blocked = (action === 'trash' || action === 'reprocess') && items.some(isBusy);
  const total = items.reduce((sum, item) => sum + reprocessCost(item), 0);
  return (
    <Modal
      open
      onClose={onClose}
      title={titles[action]}
      footer={
        <>
          {cancel}
          <button type="button" className={action === 'trash' ? 'btn-danger' : 'btn'} disabled={busy || blocked} onClick={() => void confirm(action, items)}>
            {busy && <Spinner />}
            {labels[action]}
          </button>
        </>
      }
    >
      <SelectionReview items={items} />
      {action === 'reprocess' && (
        <div className="mt-4 flex items-center justify-between rounded-lg border border-line bg-wash px-3 py-2.5 text-[12px]">
          <span className="text-muted">{k.confirm.reprocessEstimate}</span>
          <strong className="font-mono">{fill(k.addModal.estimateValue, { credits: formatNumber(total, locale) })}</strong>
        </div>
      )}
      <p className="mt-3 text-[12px] leading-relaxed text-muted">
        {blocked
          ? k.confirm.busy
          : action === 'pause'
            ? k.confirm.pauseBody
            : action === 'resume'
              ? k.confirm.enableBody
              : action === 'trash'
                ? k.confirm.trashBody
                : action === 'reprocess'
                  ? k.confirm.reprocessBody
                  : k.confirm.restoreBody}
      </p>
      {errorBox}
    </Modal>
  );
}
