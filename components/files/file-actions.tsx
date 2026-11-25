'use client';

import { useState } from 'react';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ConfirmModal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

type Errors = ReturnType<typeof useI18n>['t']['files']['errors'];

function errorText(errors: Errors, generic: string, code: unknown): string {
  return typeof code === 'string' && code in errors ? errors[code as keyof Errors] : generic;
}

/** Copies a path or a snippet; selects nothing when the clipboard refuses. */
export function CopyButton({ text, label, className = 'btn secondary sm' }: { text: string; label: string; className?: string }) {
  const { t } = useI18n();
  const toast = useToast();
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => toast(t.files.file.copied),
          () => undefined,
        );
      }}
    >
      <Icon name="copy" />
      {label}
    </button>
  );
}

/** "移到回收站" for one file or folder; afterwards the page goes to its folder. */
export function TrashButton({ path, name, folder, parentHref }: { path: string; name: string; folder: boolean; parentHref: string }) {
  const { t } = useI18n();
  const f = t.files.file;
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button type="button" className="btn secondary sm" onClick={() => setOpen(true)}>
        <Icon name="trash" />
        {f.trash}
      </button>
      <ConfirmModal
        open={open}
        title={fill(f.trashTitle, { name })}
        body={folder ? f.trashFolderBody : f.trashBody}
        confirmLabel={f.trash}
        danger
        busy={busy}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          const result = await api<{ error?: string }>('/api/files/trash', { method: 'POST', json: { path } });
          setBusy(false);
          setOpen(false);
          if (!result.ok) return toast(errorText(t.files.errors, t.common.errors.generic, result.data.error));
          toast(f.trashed);
          router.push(parentHref);
          router.refresh();
        }}
      />
    </>
  );
}

/** "恢复" on one version of a file: its content becomes the newest version. */
export function RestoreVersionButton({ path, revision }: { path: string; revision: string }) {
  const { t } = useI18n();
  const f = t.files.file;
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => setOpen(true)}>
        {f.restore}
      </button>
      <ConfirmModal
        open={open}
        title={f.restoreTitle}
        body={f.restoreBody}
        confirmLabel={f.restore}
        busy={busy}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          setBusy(true);
          const result = await api<{ error?: string }>('/api/files/restore', { method: 'POST', json: { path, revision } });
          setBusy(false);
          setOpen(false);
          if (!result.ok) return toast(errorText(t.files.errors, t.common.errors.generic, result.data.error));
          toast(f.restored);
          router.refresh();
        }}
      />
    </>
  );
}

export interface TrashItem {
  id: string;
  name: string;
  from: string;
  kind: 'file' | 'folder';
  writer: string | null;
  deletedAt: string;
  deletedLabel: string;
  keepLabel: string;
}

/** The trash: restore one, or delete the selected ones for good. */
export function TrashList({ items }: { items: TrashItem[] }) {
  const { t } = useI18n();
  const tr = t.files.trash;
  const toast = useToast();
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const restore = async (id: string) => {
    setBusy(true);
    const result = await api<{ path?: string; error?: string }>('/api/files/restore', { method: 'POST', json: { trashId: id } });
    setBusy(false);
    if (!result.ok) return toast(errorText(t.files.errors, t.common.errors.generic, result.data.error));
    toast(fill(tr.restored, { path: result.data.path ?? '' }));
    router.refresh();
  };
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  return (
    <section className="card km-results">
      <div className={`km-selection ${selected.size ? 'has-selection' : ''}`}>
        <div className="flex">
          <Icon name="info" />
          <span>{tr.hint}</span>
        </div>
        <div className="flex">
          <button type="button" className="btn secondary sm" disabled={!selected.size || busy} onClick={() => setConfirming(true)}>
            <Icon name="trash" />
            {tr.purge}
          </button>
        </div>
      </div>
      <div className="km-scroll">
        <table className="km-table">
          <thead>
            <tr>
              <th className="km-check">
                <input type="checkbox" aria-label={tr.purge} checked={items.length > 0 && selected.size === items.length} onChange={(event) => setSelected(event.target.checked ? new Set(items.map((item) => item.id)) : new Set())} />
              </th>
              <th>{tr.columns.name}</th>
              <th>{tr.columns.deletedBy}</th>
              <th className="km-date-col">{tr.columns.deletedAt}</th>
              <th>{tr.columns.keep}</th>
              <th>{tr.columns.actions}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className="km-check">
                  <input type="checkbox" aria-label={item.name} checked={selected.has(item.id)} onChange={(event) => toggle(item.id, event.target.checked)} />
                </td>
                <td>
                  <div className="km-source-name">
                    <span className="file-icon">
                      <Icon name={item.kind === 'folder' ? 'folder' : 'file'} />
                    </span>
                    <span>
                      <strong>{item.name}</strong>
                      <small>{fill(tr.from, { path: item.from })}</small>
                    </span>
                  </div>
                </td>
                <td>{item.writer ? <span className="ws-client">{item.writer}</span> : <span className="ws-muted">—</span>}</td>
                <td className="km-date-col">{item.deletedLabel}</td>
                <td>
                  <span className="ws-muted">{item.keepLabel}</span>
                </td>
                <td>
                  <div className="km-row-actions">
                    <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void restore(item.id)}>
                      <Icon name="refresh" />
                      {tr.restore}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={6}>
                  <div className="km-empty">
                    <Icon name="trash" />
                    <h3>{tr.empty}</h3>
                    <p>{tr.emptyBody}</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <ConfirmModal
        open={confirming}
        title={fill(tr.purgeTitle, { n: selected.size })}
        body={tr.purgeBody}
        confirmLabel={tr.purge}
        danger
        busy={busy}
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          setBusy(true);
          const result = await api<{ error?: string }>('/api/files/purge', { method: 'POST', json: { ids: [...selected] } });
          setBusy(false);
          setConfirming(false);
          if (!result.ok) return toast(errorText(t.files.errors, t.common.errors.generic, result.data.error));
          setSelected(new Set());
          toast(tr.purged);
          router.refresh();
        }}
      />
    </section>
  );
}
