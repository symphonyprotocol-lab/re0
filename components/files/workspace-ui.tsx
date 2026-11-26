'use client';

/**
 * The workspace's second-phase controls (docs/design/agent-workspace.md):
 * creating a Ree from a folder (with the index estimate and a cost cap), a
 * folder's index mode on the usage page, and a Ree's workspace sources on its
 * knowledge page -- bindings, "自动收录", the files waiting for confirmation
 * and "移到工作区".
 */
import { useEffect, useState } from 'react';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { api } from '@/lib/client/upload';
import { REE_CATEGORIES } from '@/lib/constants';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

type Errors = ReturnType<typeof useI18n>['t']['files']['errors'];

function useFail() {
  const { t } = useI18n();
  const toast = useToast();
  return (code: unknown) => toast(typeof code === 'string' && code in t.files.errors ? t.files.errors[code as keyof Errors] : t.common.errors.generic);
}

interface Estimate {
  files: number;
  reused: number;
  tokens: number;
  credits: number | null;
}

/** "从文件夹创建 Ree": the dialog, with what indexing the folder would cost. */
export function CreateReeButton({ path }: { path: string }) {
  const { t, locale } = useI18n();
  const c = t.files.createRee;
  const toast = useToast();
  const fail = useFail();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>('other');
  const [exclude, setExclude] = useState('');
  const [maxCost, setMaxCost] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setEstimate(null);
    void api<Estimate>(`/api/files/estimate?path=${encodeURIComponent(path)}`).then((result) => {
      if (result.ok) {
        setEstimate(result.data);
        if (result.data.credits !== null) setMaxCost(String(Math.max(1, result.data.credits * 2)));
      }
    });
  }, [open, path]);
  const create = async () => {
    setBusy(true);
    const globs = exclude.split(',').map((glob) => glob.trim()).filter(Boolean);
    const result = await api<{ reeId?: string; error?: string }>('/api/files/create-ree', {
      method: 'POST',
      json: { path, name, category, exclude: globs, ...(maxCost.trim() ? { maxCost: Number(maxCost) } : {}) },
    });
    setBusy(false);
    if (!result.ok || !result.data.reeId) return fail(result.data.error);
    setOpen(false);
    toast(c.created);
    router.push(`/rees/${result.data.reeId}/knowledge`);
  };
  const n = (value: number) => formatNumber(value, locale);
  return (
    <>
      <button type="button" className="btn secondary" onClick={() => setOpen(true)}>
        <Icon name="ree" />
        {c.button}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={c.title}
        subtitle={c.lede}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
              {t.common.actions.cancel}
            </button>
            <button type="button" className="btn" disabled={busy || !name.trim()} onClick={() => void create()}>
              {c.submit}
            </button>
          </>
        }
      >
        <div className="ws-form">
          <span className="field-label">{c.folder}</span>
          <div className="ws-picked">
            <Icon name="folder" />
            <span className="mono">{path}</span>
            {estimate && <small>{fill(c.files, { n: n(estimate.files) })}</small>}
          </div>
          <label className="field-label mt-4" htmlFor="ws-create-exclude">
            {c.exclude}
          </label>
          <input id="ws-create-exclude" className="input mono" value={exclude} placeholder="**/*.log, drafts/**" onChange={(event) => setExclude(event.target.value)} />
          <span className="hint">{c.excludeHint}</span>
          <div className="ws-two mt-4">
            <div>
              <label className="field-label" htmlFor="ws-create-name">
                {c.name}
              </label>
              <input id="ws-create-name" className="input" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
            </div>
            <div>
              <label className="field-label" htmlFor="ws-create-category">
                {c.category}
              </label>
              <select id="ws-create-category" className="input" value={category} onChange={(event) => setCategory(event.target.value)}>
                {REE_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {t.common.categories[value]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="ws-estimate mt-4">
            <div className="ws-estimate-row">
              <span>{c.toIndex}</span>
              <strong>{estimate ? fill(c.toIndexValue, { n: n(estimate.files - estimate.reused), tokens: n(estimate.tokens) }) : '…'}</strong>
            </div>
            <div className="ws-estimate-row">
              <span>{c.reused}</span>
              <strong>{estimate ? fill(c.reusedValue, { n: n(estimate.reused) }) : '…'}</strong>
            </div>
            <div className="ws-estimate-row ws-estimate-total">
              <span>{c.cost}</span>
              <strong>{estimate ? (estimate.credits === null ? c.costUnknown : fill(c.costValue, { n: n(estimate.credits) })) : '…'}</strong>
            </div>
            <div className="ws-estimate-cap">
              <label className="field-label" htmlFor="ws-create-max">
                {c.maxCost}
              </label>
              <input id="ws-create-max" className="input" inputMode="numeric" value={maxCost} onChange={(event) => setMaxCost(event.target.value.replace(/\D/g, ''))} />
              <span>{c.maxCostHint}</span>
            </div>
          </div>
          <p className="ws-fine">
            <Icon name="lock" />
            {c.privateNote}
          </p>
        </div>
      </Modal>
    </>
  );
}

export interface FolderIndexRow {
  path: string;
  kind: 'file' | 'folder';
  mode: 'inherit' | 'on' | 'off';
  bound: boolean;
}

/** The usage page's folder list: each folder's index mode, and a path to turn on. */
export function FolderIndexList({ rows }: { rows: FolderIndexRow[] }) {
  const { t } = useI18n();
  const u = t.files.usage;
  const toast = useToast();
  const fail = useFail();
  const router = useRouter();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const set = async (target: string, mode: 'on' | 'off' | 'inherit') => {
    setBusy(true);
    const result = await api<{ error?: string }>('/api/files/index', { method: 'POST', json: { path: target, mode } });
    setBusy(false);
    if (!result.ok) return fail(result.data.error);
    toast(u.saved);
    setPath('');
    router.refresh();
  };
  return (
    <section className="card ws-folder-card">
      <div className="ws-section-head">
        <strong>{u.foldersTitle}</strong>
        <small>{u.foldersHint}</small>
      </div>
      <ul>
        {rows.map((row) => (
          <li key={row.path} className="ws-folder-index">
            <span className="file-icon">
              <Icon name={row.kind === 'folder' ? 'folder' : 'file'} />
            </span>
            <div className="ws-grow">
              <strong className="mono">{row.path}</strong>
              {row.bound && <small>{u.bound}</small>}
            </div>
            <select className="input ws-mode" value={row.mode} disabled={busy} aria-label={row.path} onChange={(event) => void set(row.path, event.target.value as 'on' | 'off' | 'inherit')}>
              {(['on', 'off', 'inherit'] as const).map((mode) => (
                <option key={mode} value={mode}>
                  {u.modes[mode]}
                </option>
              ))}
            </select>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="ws-folder-index">
            <span className="ws-muted">{u.foldersEmpty}</span>
          </li>
        )}
      </ul>
      <form
        className="ws-add-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (path.trim()) void set(path.trim(), 'on');
        }}
      >
        <input className="input mono" value={path} placeholder={u.addPlaceholder} onChange={(event) => setPath(event.target.value)} aria-label={u.turnOn} />
        <button type="submit" className="btn secondary sm" disabled={busy || !path.trim()}>
          {u.turnOn}
        </button>
      </form>
    </section>
  );
}

export interface ReeCardData {
  reeId: string;
  slug: string;
  published: boolean;
  texts: number;
  bindings: { id: string; path: string; kind: 'file' | 'folder'; exclude: string[]; autoEnable: boolean; files: number }[];
  waiting: { id: string; title: string; path: string | null; secretFound: string | null; client: string | null; updatedLabel: string; chunks: number }[];
}

/** The Ree knowledge page's "工作区来源" card. */
export function WorkspaceSourcesCard({ data }: { data: ReeCardData }) {
  const { t } = useI18n();
  const r = t.files.ree;
  const toast = useToast();
  const fail = useFail();
  const router = useRouter();
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (json: Record<string, unknown>, done?: (data: Record<string, unknown>) => string) => {
    setBusy(true);
    const result = await api<Record<string, unknown> & { error?: string }>(`/api/rees/${data.reeId}/workspace`, { method: 'POST', json });
    setBusy(false);
    if (!result.ok) return fail(result.data.error);
    if (done) toast(done(result.data));
    router.refresh();
  };
  const confirmable = data.waiting.filter((row) => !row.secretFound);
  return (
    <section className="card ws-binding">
      <div className="ws-binding-head">
        <div>
          <p className="eyebrow">{r.eyebrow}</p>
          <h2>{r.title}</h2>
        </div>
        <span className="tag">{data.published ? r.publicBadge : r.privateBadge}</span>
      </div>
      {data.bindings.length === 0 && <p className="ws-muted">{r.empty}</p>}
      {data.bindings.map((binding) => (
        <div key={binding.id} className="ws-binding-row">
          <span className="file-icon">
            <Icon name={binding.kind === 'folder' ? 'folder' : 'file'} />
          </span>
          <div className="ws-grow">
            <a className="mono ws-binding-path" href={`/files?path=${encodeURIComponent(binding.path)}`}>
              {binding.path}
            </a>
            <small>
              {binding.kind === 'folder' ? fill(r.follow, { n: binding.files }) : r.followFile}
              {binding.exclude.length > 0 && ` · ${fill(r.exclude, { globs: binding.exclude.join('、') })}`}
            </small>
          </div>
          <label className="ws-auto">
            <button type="button" className="switch" role="switch" aria-checked={binding.autoEnable} aria-label={r.auto} disabled={busy} onClick={() => void act({ action: 'auto', bindingId: binding.id, value: !binding.autoEnable })} />
            <span>
              <strong>{r.auto}</strong>
              <small>{binding.autoEnable ? r.autoOn : r.autoOff}</small>
            </span>
          </label>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void act({ action: 'unbind', bindingId: binding.id }, () => r.unbound)}>
            {r.unbind}
          </button>
        </div>
      ))}
      <form
        className="ws-add-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (path.trim()) void act({ action: 'bind', path: path.trim() }, () => r.bound).then(() => setPath(''));
        }}
      >
        <input className="input mono" value={path} placeholder={r.bindPlaceholder} onChange={(event) => setPath(event.target.value)} aria-label={r.bind} />
        <button type="submit" className="btn secondary sm" disabled={busy || !path.trim()}>
          <Icon name="folder" />
          {r.bind}
        </button>
        {data.texts > 0 && (
          <button type="button" className="btn ghost sm" title={fill(r.moveHint, { n: data.texts, slug: data.slug })} disabled={busy} onClick={() => void act({ action: 'move' }, (done) => fill(r.moved, { n: Number(done.moved ?? 0), folder: String(done.folder ?? '') }))}>
            {r.move}
          </button>
        )}
      </form>
      {data.texts > 0 && <p className="ws-fine">{fill(r.moveHint, { n: data.texts, slug: data.slug })}</p>}
      {data.waiting.length > 0 && (
        <div className="ws-queue">
          <div className="ws-queue-head">
            <strong>{r.waiting}</strong>
            <span className="ws-count">{data.waiting.length}</span>
            <small>{r.waitingHint}</small>
            <span className="ws-grow" />
            {confirmable.length > 1 && (
              <button type="button" className="btn secondary sm" disabled={busy} onClick={() => void act({ action: 'confirm', ids: confirmable.map((row) => row.id) }, (done) => fill(r.decided, { n: Number(done.changed ?? 0) }))}>
                {fill(r.confirmAll, { n: confirmable.length })}
              </button>
            )}
          </div>
          <ul>
            {data.waiting.map((row) => (
              <li key={row.id} className="ws-queue-row">
                <span className="file-icon">
                  <Icon name="file" />
                </span>
                <div className="ws-grow">
                  <strong>{row.path ?? row.title}</strong>
                  <div className="ws-queue-meta">
                    {row.client && <span className="ws-client">{row.client}</span>}
                    <span>{row.updatedLabel}</span>
                    {row.secretFound ? (
                      <span className="ws-warn">
                        <Icon name="shield" />
                        {fill(r.secret, { kind: row.secretFound })}
                      </span>
                    ) : (
                      <span className="ws-muted">{fill(t.knowledge.scale.chunks, { n: row.chunks })}</span>
                    )}
                  </div>
                </div>
                <div className="flex">
                  {row.secretFound ? (
                    row.path && (
                      <a className="btn secondary sm" href={`/files?path=${encodeURIComponent(row.path)}`}>
                        {r.view}
                      </a>
                    )
                  ) : (
                    <>
                      <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void act({ action: 'dismiss', ids: [row.id] })}>
                        {r.dismiss}
                      </button>
                      <button type="button" className="btn sm" disabled={busy} onClick={() => void act({ action: 'confirm', ids: [row.id] }, (done) => fill(r.decided, { n: Number(done.changed ?? 0) }))}>
                        {r.confirm}
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
