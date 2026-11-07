'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KNOWLEDGE_BATCH_MAX, KNOWLEDGE_FOLDER_NAME_MAX, LIST_PAGE_SIZES } from '@/lib/constants';
import { KNOWLEDGE_KIND_LIST } from '@/lib/domain/knowledge';
import type { KnowledgeListItem, KnowledgeTab } from '@/lib/services/knowledge';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { RowMenu, type MenuItem } from '@/components/ui/row-menu';
import { ConfirmModal, Modal } from '@/components/knowledge/modal';
import { useToast } from '@/components/ui/toast';
import { AddKnowledgeModal } from '@/components/knowledge/add-knowledge';
import { KnowledgePreview } from '@/components/knowledge/knowledge-preview';
import { KnowledgeDialogs, isBusy, reprocessCost, type ActionItem, type BulkAction, type Dialog } from '@/components/knowledge/knowledge-dialogs';
import { StatusBadge, failureLabel } from '@/components/knowledge/status-badge';
import { clock, errorText, highlight, SOURCE_ICONS, Switch } from '@/components/knowledge/shared';
import '@/components/knowledge/knowledge.css';

type Item = Omit<KnowledgeListItem, 'updatedAt' | 'deletedAt'> & { updatedAt: string; deletedAt: string | null };

interface ListResponse {
  items: Item[];
  total: number;
  page: number;
  size: number;
  counts: Record<KnowledgeTab | 'trash', number>;
  folder: string;
  folders: { id: string; name: string; count: number }[];
  folderCounts: { all: number; unfiled: number };
}

const TABS: KnowledgeTab[] = ['all', 'ready', 'processing', 'failed', 'paused'];
const SORTS = ['new', 'old', 'title'] as const;
const SORT_ALIASES: Record<string, (typeof SORTS)[number]> = { recent: 'new', oldest: 'old', name: 'title' };

/** The library's URL state (prototype knowledge.js `syncURL`): defaults are left out. */
export function libraryQuery(search: URLSearchParams) {
  const sort = SORT_ALIASES[search.get('sort') ?? ''] ?? search.get('sort') ?? 'new';
  return {
    q: search.get('q') ?? '',
    status: (TABS as string[]).includes(search.get('status') ?? '') ? (search.get('status') as KnowledgeTab) : 'all',
    kind: (KNOWLEDGE_KIND_LIST as readonly string[]).includes(search.get('kind') ?? '') ? search.get('kind')! : 'all',
    sort: (SORTS as readonly string[]).includes(sort) ? sort : 'new',
    size: (LIST_PAGE_SIZES as readonly number[]).includes(Number(search.get('size'))) ? Number(search.get('size')) : 20,
    page: Math.max(1, Number(search.get('page')) || 1),
    folder: search.get('folder') || 'all',
    trash: search.get('view') === 'trash',
    preview: search.get('preview'),
  };
}
type Query = ReturnType<typeof libraryQuery>;

export function libraryParams(query: Omit<Query, 'preview'> & { preview?: string | null }): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.kind !== 'all') params.set('kind', query.kind);
  if (query.folder !== 'all') params.set('folder', query.folder);
  if (query.status !== 'all' && !query.trash) params.set('status', query.status);
  if (query.sort !== 'new') params.set('sort', query.sort);
  if (query.size !== 20) params.set('size', String(query.size));
  if (query.page > 1) params.set('page', String(query.page));
  if (query.trash) params.set('view', 'trash');
  if (query.preview) params.set('preview', query.preview);
  return params;
}

function actionItem(item: Item): ActionItem {
  return { id: item.id, title: item.title, kind: item.kind, status: item.status, enabled: item.enabled, folderId: item.folderId, fileSize: item.fileSize, chars: item.chars, deletedAt: item.deletedAt };
}

/**
 * `/rees/[id]/knowledge` (prototype knowledge.js): folders, status tabs and
 * the trash, search / type / sort, the "参与回答" switch, cross-page
 * selection with "选择全部 N 个筛选结果" and batch actions. Every filter is
 * in the URL and done by the server; rows still processing are polled.
 */
export function KnowledgeManager({ reeId }: { reeId: string }) {
  const { t, locale } = useI18n();
  const k = t.knowledge;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const toast = useToast();
  const query = libraryQuery(search);
  const [data, setData] = useState<ListResponse | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [q, setQ] = useState(query.q);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Map<string, ActionItem>>(new Map());
  const [selectingAll, setSelectingAll] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [folderForm, setFolderForm] = useState<{ id: string | null; name: string } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ id: string; name: string } | null>(null);
  const [folderDelete, setFolderDelete] = useState<{ id: string; name: string } | null>(null);
  const [folderError, setFolderError] = useState('');
  const [neighbors, setNeighbors] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchKey = search.toString();

  const go = useCallback(
    (changes: Partial<Query>, options: { keepSelection?: boolean } = {}) => {
      const next = { ...libraryQuery(new URLSearchParams(searchKey)), ...changes };
      const value = libraryParams(next).toString();
      if (!options.keepSelection) setSelected(new Map());
      router.push(value ? `${pathname}?${value}` : pathname, { scroll: false });
    },
    [pathname, router, searchKey],
  );

  const load = useCallback(async () => {
    const params = new URLSearchParams(searchKey);
    params.delete('preview');
    const result = await api<ListResponse>(`/api/rees/${reeId}/knowledge?${params.toString()}`);
    if (result.ok) {
      setData(result.data);
      setLoadedKey(searchKey);
    }
  }, [reeId, searchKey]);

  /* An out-of-range page: the server answered the last one, the address follows it (prototype `syncURL`). */
  useEffect(() => {
    if (!data || loadedKey !== searchKey) return;
    const current = libraryQuery(new URLSearchParams(searchKey));
    if (current.page === data.page) return;
    const value = libraryParams({ ...current, page: data.page }).toString();
    router.replace(value ? `${pathname}?${value}` : pathname, { scroll: false });
  }, [data, loadedKey, searchKey, pathname, router]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => setQ(query.q), [query.q]);

  /* Search as you type, debounced (prototype: 160 ms). */
  useEffect(() => {
    if (q === query.q) return;
    const timer = setTimeout(() => go({ q: q.trim(), page: 1 }), 300);
    return () => clearTimeout(timer);
  }, [q, query.q, go]);

  /* ⌘K / Ctrl+K focuses the search. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const busy = data?.items.some(isBusy) ?? false;
  const [wasBusy, setWasBusy] = useState(false);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [busy, load]);
  /* Processing settled: the sidebar balance changed with it. */
  useEffect(() => {
    if (wasBusy && !busy) router.refresh();
    setWasBusy(busy);
  }, [busy, wasBusy, router]);

  /* Previous / next in the preview walk the whole filtered list, not just this page. */
  useEffect(() => {
    if (!query.preview) return;
    const params = new URLSearchParams(searchKey);
    params.delete('preview');
    params.set('ids', '1');
    void api<{ ids: string[] }>(`/api/rees/${reeId}/knowledge?${params.toString()}`).then((result) => result.ok && setNeighbors(result.data.ids));
  }, [query.preview, reeId, searchKey]);

  const refreshAll = async () => {
    await load();
    router.refresh();
  };

  const toggle = async (item: Item) => {
    const result = await api<{ error?: string }>(`/api/rees/${reeId}/knowledge/${item.id}`, { method: 'PATCH', json: { enabled: !item.enabled } });
    if (!result.ok) return toast(errorText(t, result.data.error));
    toast(fill(k.done.scope, { n: 1 }));
    await load();
  };

  const sourceMenu = (item: Item): MenuItem[] => {
    const source = actionItem(item);
    const preview: MenuItem = { label: k.menu.preview, icon: 'external', onSelect: () => go({ preview: item.id }, { keepSelection: true }) };
    if (query.trash) return [preview, { label: k.menu.restore, icon: 'refresh', onSelect: () => setDialog({ type: 'confirm', action: 'restore', items: [source] }) }];
    return [
      preview,
      { label: k.menu.move, icon: 'folder', onSelect: () => setDialog({ type: 'move', items: [source] }) },
      { label: k.menu.rename, icon: 'settings', onSelect: () => setDialog({ type: 'rename', item: source }) },
      { label: item.enabled ? k.menu.pause : k.menu.enable, icon: item.enabled ? 'pause' : 'play', onSelect: () => void toggle(item) },
      { label: fill(k.menu.reprocess, { credits: n(reprocessCost(source)) }), icon: 'refresh', disabled: isBusy(source), onSelect: () => setDialog({ type: 'confirm', action: 'reprocess', items: [source] }) },
      { label: k.menu.trash, icon: 'trash', danger: true, disabled: isBusy(source), onSelect: () => setDialog({ type: 'confirm', action: 'trash', items: [source] }) },
    ];
  };

  const page = data?.items ?? [];
  const pageSelected = page.length > 0 && page.every((item) => selected.has(item.id));
  const somePageSelected = page.some((item) => selected.has(item.id));
  const selectedItems = useMemo(() => [...selected.values()], [selected]);
  const selectPage = (checked: boolean) => {
    const next = new Map(selected);
    for (const item of page) checked ? next.set(item.id, actionItem(item)) : next.delete(item.id);
    setSelected(next);
  };
  const selectAllMatching = async () => {
    setSelectingAll(true);
    const params = new URLSearchParams(searchKey);
    params.delete('preview');
    params.set('ids', 'items');
    /* One request: the matching sources arrive with what the dialogs list and price; the server checks each again on the action. */
    const result = await api<{ items: ActionItem[] }>(`/api/rees/${reeId}/knowledge?${params.toString()}`);
    setSelectingAll(false);
    if (!result.ok) return;
    const next = new Map(selected);
    for (const item of result.data.items) next.set(item.id, item);
    setSelected(next);
  };

  const bulk = (action: BulkAction | 'move') => {
    setDialog(action === 'move' ? { type: 'move', items: selectedItems } : { type: 'confirm', action, items: selectedItems });
  };

  const saveFolder = async () => {
    if (!folderForm) return;
    setFolderError('');
    const result = folderForm.id
      ? await api<{ folder?: { id: string }; error?: string }>(`/api/rees/${reeId}/folders/${folderForm.id}`, { method: 'PATCH', json: { name: folderForm.name } })
      : await api<{ folder?: { id: string }; error?: string }>(`/api/rees/${reeId}/folders`, { method: 'POST', json: { name: folderForm.name } });
    if (!result.ok) return setFolderError(errorText(t, result.data.error));
    const created = !folderForm.id;
    setFolderForm(null);
    toast(k.folders.saved);
    if (created && result.data.folder) go({ folder: result.data.folder.id, page: 1, trash: false, status: 'all', q: '', kind: 'all' });
    else await load();
  };

  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(query.q) || query.kind !== 'all' || query.status !== 'all';
  const folderName = (id: string) => (id === 'all' ? k.folders.all : id === 'unfiled' ? k.folders.unfiled : (data?.folders.find((folder) => folder.id === id)?.name ?? k.folders.all));
  const currentFolder = data?.folder ?? query.folder;
  const folderCount = currentFolder === 'all' ? data?.folderCounts.all : currentFolder === 'unfiled' ? data?.folderCounts.unfiled : data?.folders.find((folder) => folder.id === currentFolder)?.count;
  const position = query.preview ? neighbors.indexOf(query.preview) : -1;
  const previewItem = data?.items.find((item) => item.id === query.preview);

  const scale = (item: Item) =>
    item.kind === 'site'
      ? fill(k.scale.pages, { n: n(item.children) })
      : item.kind === 'github'
        ? fill(k.scale.files, { n: n(item.children) })
        : item.kind === 'audio' && item.duration
          ? clock(item.duration)
          : fill(k.scale.chars, { n: n(item.chars) });

  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  const emptyIcon = query.trash ? 'trash' : filtered || currentFolder !== 'all' ? 'search' : 'file';

  const folderRow = (id: string, label: string, count: number | undefined, editable: boolean) => (
    <div key={id} className={`km-folder-row ${currentFolder === id ? 'active' : ''}`}>
      <button type="button" className="km-folder-link" aria-pressed={currentFolder === id} title={label} onClick={() => go({ folder: id, page: 1 })}>
        <Icon name={id === 'all' ? 'layers' : 'folder'} />
        <span>{label}</span>
        <small>{count ?? '–'}</small>
      </button>
      {editable && (
        <button type="button" className="icon-btn" aria-label={fill(k.folders.manage, { name: label })} title={fill(k.folders.manage, { name: label })} onClick={() => setFolderMenu({ id, name: label })}>
          <Icon name="dots" />
        </button>
      )}
    </div>
  );

  const bulkButton = (icon: 'folder' | 'refresh' | 'pause' | 'play' | 'trash', label: string, action: BulkAction | 'move') => (
    <button type="button" className="btn secondary sm" onClick={() => bulk(action)}>
      <Icon name={icon} />
      {label}
    </button>
  );

  return (
    <main className="knowledge-ui">
      <div className="km-page">
        <div className="km-page-head">
          <div>
            <p className="eyebrow">{k.eyebrow}</p>
            <h1>
              {k.title} <span className="mono">{data ? n(data.folderCounts.all) : ''}</span>
            </h1>
            <p>{k.lede}</p>
          </div>
          <div className="flex">
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              <Icon name="plus" />
              {k.add}
            </button>
          </div>
        </div>
        <div className="km-library-layout">
          <aside className="km-folders" aria-label={k.folders.label}>
            <div className="km-folders-head">
              <strong>{k.folders.title}</strong>
              <button type="button" className="icon-btn" aria-label={k.folders.create} title={k.folders.create} onClick={() => setFolderForm({ id: null, name: '' })}>
                <Icon name="plus" />
              </button>
            </div>
            <nav aria-label={k.folders.nav}>
              {folderRow('all', k.folders.all, data?.folderCounts.all, false)}
              {folderRow('unfiled', k.folders.unfiled, data?.folderCounts.unfiled, false)}
              <div className="km-folder-divider" />
              {data ? (
                data.folders.map((folder) => folderRow(folder.id, folder.name, folder.count, true))
              ) : (
                <p className="km-folders-loading" role="status">
                  <i className="spinner" aria-hidden="true" />
                  {t.common.actions.loading}
                </p>
              )}
            </nav>
            {data && data.folders.length === 0 && <p className="km-folders-empty">{k.folders.empty}</p>}
            <button type="button" className="km-folder-new" onClick={() => setFolderForm({ id: null, name: '' })}>
              <Icon name="plus" />
              {k.folders.create}
            </button>
            <p className="km-folders-hint">{k.folders.hint}</p>
          </aside>

          <div className="km-library-content">
            <div className="km-folder-context">
              <Icon name={currentFolder === 'all' ? 'layers' : 'folder'} />
              <strong>{folderName(currentFolder)}</strong>
              <span>{folderCount !== undefined && fill(k.folders.sources, { n: n(folderCount) })}</span>
            </div>

            <div className="km-state-tabs">
              {TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={`km-state-tab ${!query.trash && query.status === tab ? 'active' : ''}`}
                  aria-pressed={!query.trash && query.status === tab}
                  onClick={() => go({ status: tab, trash: false, page: 1 })}
                >
                  {k.tabs[tab]}
                  <span>{data ? n(data.counts[tab]) : '–'}</span>
                </button>
              ))}
              <div className="grow" />
              <button type="button" className={`km-state-tab ${query.trash ? 'active' : ''}`} aria-pressed={query.trash} onClick={() => go({ trash: !query.trash, status: 'all', page: 1 })}>
                <Icon name="trash" />
                {k.trash}
                <span>{data ? n(data.counts.trash) : '–'}</span>
              </button>
            </div>

            <form
              className="km-filters"
              onSubmit={(event) => {
                event.preventDefault();
                go({ q: q.trim(), page: 1 });
              }}
            >
              <div className="km-search">
                <Icon name="search" />
                <input ref={searchRef} name="q" type="search" aria-label={k.searchLabel} value={q} placeholder={k.search} autoComplete="off" onChange={(event) => setQ(event.target.value)} />
                <kbd>⌘ K</kbd>
              </div>
              <select name="kind" aria-label={k.kindLabel} value={query.kind} onChange={(event) => go({ kind: event.target.value, page: 1 })}>
                <option value="all">{k.kindAll}</option>
                {KNOWLEDGE_KIND_LIST.map((kind) => (
                  <option key={kind} value={kind}>
                    {t.common.kinds[kind]}
                  </option>
                ))}
              </select>
              <select name="sort" aria-label={k.sortLabel} value={query.sort} onChange={(event) => go({ sort: event.target.value, page: 1 })}>
                {SORTS.map((sort) => (
                  <option key={sort} value={sort}>
                    {k.sorts[sort]}
                  </option>
                ))}
              </select>
              {filtered && (
                <button type="button" className="btn ghost sm" onClick={() => go({ q: '', kind: 'all', status: 'all', page: 1 })}>
                  {k.clearFilters}
                </button>
              )}
            </form>

            <section className="card km-results">
              <div className={`km-selection ${selected.size ? 'has-selection' : ''}`}>
                <div className="flex">
                  <Icon name={selected.size ? 'check' : 'info'} />
                  <span>{selected.size ? fill(k.selection.count, { n: n(selected.size) }) : k.selection.hint}</span>
                  {selected.size > 0 && (
                    <button type="button" className="text-link" onClick={() => setSelected(new Map())}>
                      {k.selection.clear}
                    </button>
                  )}
                </div>
                <div className="flex">
                  {selected.size > 0 &&
                    (query.trash ? (
                      bulkButton('refresh', k.selection.restore, 'restore')
                    ) : (
                      <>
                        {bulkButton('folder', k.selection.move, 'move')}
                        {bulkButton('refresh', k.selection.reprocess, 'reprocess')}
                        {bulkButton('pause', k.selection.pause, 'pause')}
                        {bulkButton('play', k.selection.enable, 'resume')}
                        {bulkButton('trash', k.selection.trash, 'trash')}
                      </>
                    ))}
                </div>
              </div>
              {data && pageSelected && selected.size < Math.min(data.total, KNOWLEDGE_BATCH_MAX) && (
                <div className="km-select-all">
                  {k.selection.page}{' '}
                  <button type="button" className="text-link" onClick={selectAllMatching} disabled={selectingAll}>
                    {selectingAll && <i className="spinner" />}
                    {/* One batch takes at most KNOWLEDGE_BATCH_MAX sources; past that the offer says so. */}
                    {data.total > KNOWLEDGE_BATCH_MAX ? fill(k.selection.allCapped, { n: n(KNOWLEDGE_BATCH_MAX), total: n(data.total) }) : fill(k.selection.all, { n: n(data.total) })}
                  </button>
                </div>
              )}
              <div className="km-scroll">
                <table className="km-table">
                  <thead>
                    <tr>
                      <th className="km-check">
                        <input
                          type="checkbox"
                          aria-label={k.selection.selectPage}
                          checked={pageSelected}
                          disabled={page.length === 0}
                          ref={(input) => {
                            if (input) input.indeterminate = somePageSelected && !pageSelected;
                          }}
                          onChange={(event) => selectPage(event.target.checked)}
                        />
                      </th>
                      <th>{k.columns.name}</th>
                      <th>{k.columns.status}</th>
                      <th className="km-enabled-col">{k.columns.enabled}</th>
                      <th className="km-meta-col">{k.columns.size}</th>
                      <th className="km-date-col">{k.columns.updated}</th>
                      <th>{k.columns.actions}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.map((item) => (
                      <tr key={item.id} className={selected.has(item.id) ? 'selected' : ''}>
                        <td className="km-check">
                          <input
                            type="checkbox"
                            aria-label={fill(k.selection.select, { title: item.title })}
                            checked={selected.has(item.id)}
                            onChange={(event) => {
                              const next = new Map(selected);
                              event.target.checked ? next.set(item.id, actionItem(item)) : next.delete(item.id);
                              setSelected(next);
                            }}
                          />
                        </td>
                        <td>
                          <div className="km-source-name">
                            <span className="file-icon">
                              <Icon name={SOURCE_ICONS[item.kind]} />
                            </span>
                            <span>
                              <button type="button" className="km-title" title={item.title} onClick={() => go({ preview: item.id }, { keepSelection: true })}>
                                {highlight(item.title, query.q)}
                              </button>
                              <small>
                                {t.common.kinds[item.kind]} · {item.source ?? item.fileName ?? k.uploaded}
                              </small>
                              <span className="km-source-folder">
                                <Icon name="folder" />
                                {item.folderId ? folderName(item.folderId) : k.folders.unfiled}
                              </span>
                            </span>
                          </div>
                        </td>
                        <td>
                          <StatusBadge status={item.status} />
                          {item.status === 'failed' && (
                            <small className="km-failure" title={failureLabel(t, item.error)}>
                              {failureLabel(t, item.error)}
                            </small>
                          )}
                        </td>
                        <td className="km-enabled-col">
                          {query.trash ? (
                            <span className="muted">—</span>
                          ) : (
                            <>
                              <Switch checked={item.enabled} label={fill(k.toggleLabel, { title: item.title })} onChange={() => toggle(item)} />
                              <small className="km-scope-label">{item.enabled ? (item.status === 'ready' ? k.enabledLabel.on : k.enabledLabel.waiting) : k.enabledLabel.off}</small>
                            </>
                          )}
                        </td>
                        <td className="km-meta-col">
                          <span>{scale(item)}</span>
                          <small>{fill(k.scale.chunks, { n: n(item.chunks) })}</small>
                        </td>
                        <td className="km-date-col">{formatDateTime(item.updatedAt, locale)}</td>
                        <td>
                          <div className="km-row-actions">
                            <RowMenu label={fill(k.more, { title: item.title })} items={sourceMenu(item)} />
                          </div>
                        </td>
                      </tr>
                    ))}
                    {page.length === 0 && (
                      <tr>
                        <td colSpan={7}>
                          <div className="km-empty">
                            {!data ? <i className="spinner" /> : <Icon name={emptyIcon} />}
                            {data && (
                              <>
                                <h3>{query.trash ? k.trashEmpty : filtered || currentFolder !== 'all' ? k.emptyTitle : k.firstTitle}</h3>
                                <p>{filtered || query.trash || currentFolder !== 'all' ? k.emptyBody : k.firstBody}</p>
                                {filtered ? (
                                  <button type="button" className="btn secondary sm" onClick={() => go({ q: '', kind: 'all', status: 'all', page: 1 })}>
                                    {k.clearFiltersLong}
                                  </button>
                                ) : (
                                  !query.trash && (
                                    <button type="button" className="btn secondary sm" onClick={() => setAdding(true)}>
                                      <Icon name="plus" />
                                      {k.add}
                                    </button>
                                  )
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="km-pagination">
                <span>{data && data.total ? fill(t.common.pager.range, { from: n((data.page - 1) * data.size + 1), to: n(Math.min(data.page * data.size, data.total)), total: n(data.total) }) : t.common.pager.empty}</span>
                <div className="flex">
                  <label>
                    {t.common.pager.perPage}{' '}
                    <select aria-label={k.rowsLabel} value={query.size} onChange={(event) => go({ size: Number(event.target.value), page: 1 })}>
                      {LIST_PAGE_SIZES.map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="icon-btn flip" aria-label={t.common.pager.previous} title={t.common.pager.previous} disabled={!data || data.page <= 1} onClick={() => go({ page: (data?.page ?? 1) - 1 }, { keepSelection: true })}>
                    <Icon name="chevronRight" />
                  </button>
                  <span className="mono">
                    {data?.page ?? query.page} / {pages}
                  </span>
                  <button type="button" className="icon-btn" aria-label={t.common.pager.next} title={t.common.pager.next} disabled={!data || data.page >= pages} onClick={() => go({ page: (data?.page ?? 1) + 1 }, { keepSelection: true })}>
                    <Icon name="chevronRight" />
                  </button>
                </div>
              </div>
            </section>
            <div className="km-page-note">
              <span>
                <Icon name="shield" />
                {k.note}
              </span>
              <span>{k.noteChildren}</span>
            </div>
          </div>
        </div>
      </div>

      <AddKnowledgeModal
        open={adding}
        reeId={reeId}
        folder={currentFolder !== 'all' && currentFolder !== 'unfiled' ? { id: currentFolder, name: folderName(currentFolder) } : null}
        onClose={() => setAdding(false)}
        onAdded={async () => {
          setAdding(false);
          toast(k.addModal.added);
          await refreshAll();
        }}
      />

      <KnowledgeDialogs
        reeId={reeId}
        dialog={dialog}
        folders={data?.folders}
        onClose={() => setDialog(null)}
        onDone={async (message) => {
          setDialog(null);
          setSelected(new Map());
          toast(message);
          await refreshAll();
        }}
      />

      <Modal
        open={Boolean(query.preview)}
        onClose={() => go({ preview: null }, { keepSelection: true })}
        wide
        className="kp-modal"
        title={previewItem?.title ?? k.preview}
        subtitle={previewItem ? `${t.common.kinds[previewItem.kind]} · ${k.ownerOnly}` : k.ownerOnly}
        footer={
          <div className="kp-nav">
            <span>{position >= 0 && fill(k.page.position, { n: n(position + 1), total: n(neighbors.length) })}</span>
            <div className="flex">
              <button type="button" className="btn secondary sm" data-value="-1" disabled={position <= 0} onClick={() => go({ preview: neighbors[position - 1] }, { keepSelection: true })}>
                <Icon name="chevronRight" />
                {k.page.previous}
              </button>
              <button type="button" className="btn secondary sm" disabled={position < 0 || position >= neighbors.length - 1} onClick={() => go({ preview: neighbors[position + 1] }, { keepSelection: true })}>
                {k.page.next}
                <Icon name="chevronRight" />
              </button>
              <Link href={`/rees/${reeId}/knowledge/${query.preview}?${libraryParams({ ...query, preview: null }).toString()}`} className="btn secondary sm">
                {k.openPage}
              </Link>
            </div>
          </div>
        }
      >
        {query.preview && <KnowledgePreview reeId={reeId} knowledgeId={query.preview} layout="modal" onChanged={() => void refreshAll()} />}
      </Modal>

      <Modal
        open={Boolean(folderForm)}
        onClose={() => setFolderForm(null)}
        title={folderForm?.id ? k.folders.rename : k.folders.create}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setFolderForm(null)}>
              {t.common.actions.cancel}
            </button>
            <button type="submit" form="knowledge-folder-form" className="btn">
              {k.folders.save}
            </button>
          </>
        }
      >
        <form
          id="knowledge-folder-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveFolder();
          }}
        >
          <div className="field">
            <label htmlFor="km-folder-name">{k.folders.nameLabel}</label>
            <input
              id="km-folder-name"
              value={folderForm?.name ?? ''}
              maxLength={KNOWLEDGE_FOLDER_NAME_MAX}
              placeholder={k.folders.namePlaceholder}
              required
              autoFocus
              onChange={(event) => setFolderForm((current) => (current ? { ...current, name: event.target.value } : current))}
            />
          </div>
          {folderError && (
            <p role="alert" className="form-error">
              {folderError}
            </p>
          )}
        </form>
      </Modal>

      <Modal open={Boolean(folderMenu)} onClose={() => setFolderMenu(null)} title={folderMenu?.name ?? ''} subtitle={k.folders.menuSubtitle} className="ks-menu-modal">
        <div className="ks-action-menu">
          <button
            type="button"
            className="ks-menu-item"
            onClick={() => {
              setFolderError('');
              setFolderForm({ id: folderMenu!.id, name: folderMenu!.name });
              setFolderMenu(null);
            }}
          >
            <Icon name="settings" />
            {k.folders.rename}
          </button>
          <button
            type="button"
            className="ks-menu-item danger-text"
            onClick={() => {
              setFolderDelete(folderMenu);
              setFolderMenu(null);
            }}
          >
            <Icon name="trash" />
            {k.folders.delete}
          </button>
        </div>
      </Modal>

      <ConfirmModal
        open={Boolean(folderDelete)}
        title={fill(k.folders.deleteTitle, { name: folderDelete?.name ?? '' })}
        body={k.folders.deleteBody}
        confirmLabel={k.folders.delete}
        danger
        onClose={() => setFolderDelete(null)}
        onConfirm={async () => {
          const folder = folderDelete!;
          setFolderDelete(null);
          const result = await api(`/api/rees/${reeId}/folders/${folder.id}`, { method: 'DELETE' });
          if (!result.ok) return toast(t.common.errors.generic);
          toast(k.folders.deleted);
          if (currentFolder === folder.id) go({ folder: 'unfiled', page: 1 });
          else await load();
        }}
      />
    </main>
  );
}

