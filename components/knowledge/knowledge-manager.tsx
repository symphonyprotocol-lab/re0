'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KNOWLEDGE_FOLDER_NAME_MAX, LIST_PAGE_SIZES } from '@/lib/constants';
import { KNOWLEDGE_KIND_LIST } from '@/lib/domain/knowledge';
import type { KnowledgeListItem, KnowledgeTab } from '@/lib/services/knowledge';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { Pager } from '@/components/ui/pager';
import { useToast } from '@/components/ui/toast';
import { AddKnowledgeModal } from '@/components/knowledge/add-knowledge';
import { KnowledgePreview } from '@/components/knowledge/knowledge-preview';
import { KnowledgeDialogs, isBusy, type ActionItem, type BulkAction, type Dialog } from '@/components/knowledge/knowledge-dialogs';
import { StatusBadge, failureLabel } from '@/components/knowledge/status-badge';
import { clock, errorText, highlight, KIND_ICONS, Switch } from '@/components/knowledge/shared';

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
    if (result.ok) setData(result.data);
  }, [reeId, searchKey]);

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
    params.set('ids', '1');
    const ids = await api<{ ids: string[] }>(`/api/rees/${reeId}/knowledge?${params.toString()}`);
    setSelectingAll(false);
    if (!ids.ok) return;
    const next = new Map(selected);
    /* Rows off this page are known by id only until an action lists them; the server checks each one. */
    for (const id of ids.data.ids) if (!next.has(id)) next.set(id, { id, title: id, kind: 'document', status: 'ready', enabled: true, folderId: null, fileSize: null, chars: 0, deletedAt: null });
    setSelected(next);
  };

  /* Rows known by id only are fetched before a dialog lists or prices them. */
  const withDetails = async (items: ActionItem[]): Promise<ActionItem[]> => {
    const unknown = items.filter((item) => item.title === item.id);
    if (unknown.length === 0) return items;
    const params = new URLSearchParams(searchKey);
    params.delete('preview');
    params.set('size', '100');
    const known = new Map(items.map((item) => [item.id, item]));
    for (let pageNo = 1; [...known.values()].some((item) => item.title === item.id); pageNo += 1) {
      params.set('page', String(pageNo));
      const result = await api<ListResponse>(`/api/rees/${reeId}/knowledge?${params.toString()}`);
      if (!result.ok || result.data.items.length === 0 || result.data.page < pageNo) break;
      for (const row of result.data.items) if (known.has(row.id)) known.set(row.id, actionItem(row));
    }
    return [...known.values()];
  };

  const bulk = async (action: BulkAction | 'move') => {
    const items = await withDetails(selectedItems);
    setDialog(action === 'move' ? { type: 'move', items } : { type: 'confirm', action, items });
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

  const scale = (item: Item) =>
    item.kind === 'site'
      ? fill(k.scale.pages, { n: n(item.children) })
      : item.kind === 'github'
        ? fill(k.scale.files, { n: n(item.children) })
        : item.kind === 'audio' && item.duration
          ? clock(item.duration)
          : fill(k.scale.chars, { n: n(item.chars) });

  const folderButton = (id: string, label: string, count: number | undefined, editable: boolean) => (
    <div key={id} className={`group flex flex-none items-center rounded-lg md:flex-auto ${currentFolder === id ? 'bg-soft text-blue' : 'hover:bg-wash'}`}>
      <button
        type="button"
        aria-pressed={currentFolder === id}
        title={label}
        onClick={() => go({ folder: id, page: 1 })}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-[12px] font-semibold"
      >
        <Icon name={id === 'all' ? 'layers' : 'folder'} className="size-4 flex-none" />
        <span className="max-w-[140px] truncate md:max-w-none">{label}</span>
        <small className="ml-auto pl-1 font-mono text-[10px] text-muted">{count ?? '–'}</small>
      </button>
      {editable && (
        <button type="button" className="icon-btn size-7" aria-label={fill(k.folders.manage, { name: label })} onClick={() => setFolderMenu({ id, name: label })}>
          <Icon name="dots" className="size-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-8 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">{k.eyebrow}</p>
          <h1 className="mt-2 flex items-baseline gap-2 text-[28px] font-extrabold tracking-tight">
            {k.title}
            <span className="font-mono text-[14px] font-medium text-muted">{data ? n(data.folderCounts.all) : ''}</span>
          </h1>
          <p className="mt-2 text-[13px] text-muted">{k.lede}</p>
        </div>
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          {k.add}
        </button>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-[220px_minmax(0,1fr)]">
        <aside aria-label={k.folders.label} className="min-w-0 md:sticky md:top-[124px] md:h-fit">
          <div className="mb-2 flex items-center justify-between">
            <strong className="text-[12px]">{k.folders.title}</strong>
            <button type="button" className="icon-btn" aria-label={k.folders.create} onClick={() => setFolderForm({ id: null, name: '' })}>
              <Icon name="plus" />
            </button>
          </div>
          <nav aria-label={k.folders.nav} className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:flex-col md:overflow-visible md:px-0">
            {folderButton('all', k.folders.all, data?.folderCounts.all, false)}
            {folderButton('unfiled', k.folders.unfiled, data?.folderCounts.unfiled, false)}
            <div className="hidden h-px bg-line md:my-1 md:block" />
            {data?.folders.map((folder) => folderButton(folder.id, folder.name, folder.count, true))}
          </nav>
          {data && data.folders.length === 0 && <p className="mt-2 hidden text-[11px] text-muted md:block">{k.folders.empty}</p>}
          <button type="button" className="btn-ghost mt-2 hidden md:inline-flex" onClick={() => setFolderForm({ id: null, name: '' })}>
            <Icon name="plus" className="size-3.5" />
            {k.folders.create}
          </button>
          <p className="mt-1 hidden text-[11px] text-muted md:block">{k.folders.hint}</p>
        </aside>

        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px]">
            <Icon name={currentFolder === 'all' ? 'layers' : 'folder'} className="size-4 text-blue" />
            <strong className="min-w-0 truncate">{folderName(currentFolder)}</strong>
            <span className="flex-none text-[12px] text-muted">{folderCount !== undefined && fill(k.folders.sources, { n: n(folderCount) })}</span>
          </div>

          <div className="mt-3 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
            {TABS.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={!query.trash && query.status === tab}
                onClick={() => go({ status: tab, trash: false, page: 1 })}
                className={`flex flex-none items-center gap-1.5 border-b-2 px-3 py-2.5 text-[12px] font-semibold whitespace-nowrap ${
                  !query.trash && query.status === tab ? 'border-blue text-blue' : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                {k.tabs[tab]}
                <span className="rounded-full bg-wash px-1.5 font-mono text-[10px]">{data ? n(data.counts[tab]) : '–'}</span>
              </button>
            ))}
            <div className="min-w-2 flex-1" />
            <button
              type="button"
              role="tab"
              aria-selected={query.trash}
              onClick={() => go({ trash: !query.trash, status: 'all', page: 1 })}
              className={`flex flex-none items-center gap-1.5 border-b-2 px-3 py-2.5 text-[12px] font-semibold whitespace-nowrap ${
                query.trash ? 'border-blue text-blue' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              <Icon name="trash" className="size-3.5" />
              {k.trash}
              <span className="rounded-full bg-wash px-1.5 font-mono text-[10px]">{data ? n(data.counts.trash) : '–'}</span>
            </button>
          </div>

          <form
            className="mt-4 flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              go({ q: q.trim(), page: 1 });
            }}
          >
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">{k.searchLabel}</span>
              <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[#a3a9bb]" />
              <input ref={searchRef} className="input pr-12 pl-9" type="search" value={q} placeholder={k.search} onChange={(event) => setQ(event.target.value)} />
              <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded border border-line px-1.5 font-mono text-[10px] text-muted sm:block">⌘ K</kbd>
            </label>
            <div className="flex gap-2">
              <select className="input min-w-0 sm:w-[140px]" aria-label={k.kindLabel} value={query.kind} onChange={(event) => go({ kind: event.target.value, page: 1 })}>
                <option value="all">{k.kindAll}</option>
                {KNOWLEDGE_KIND_LIST.map((kind) => (
                  <option key={kind} value={kind}>
                    {t.common.kinds[kind]}
                  </option>
                ))}
              </select>
              <select className="input min-w-0 sm:w-[140px]" aria-label={k.sortLabel} value={query.sort} onChange={(event) => go({ sort: event.target.value, page: 1 })}>
                {SORTS.map((sort) => (
                  <option key={sort} value={sort}>
                    {k.sorts[sort]}
                  </option>
                ))}
              </select>
              {filtered && (
                <button type="button" className="btn-ghost flex-none" onClick={() => go({ q: '', kind: 'all', status: 'all', page: 1 })}>
                  {k.clearFilters}
                </button>
              )}
            </div>
          </form>

          <section className="card mt-4 overflow-hidden">
            <div className={`flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-[12px] ${selected.size ? 'bg-soft' : 'bg-wash'}`}>
              <div className="flex min-w-0 items-center gap-2">
                {page.length > 0 && (
                  <input type="checkbox" className="xl:hidden" aria-label={k.selection.selectPage} checked={pageSelected} onChange={(event) => selectPage(event.target.checked)} />
                )}
                <Icon name={selected.size ? 'check' : 'info'} className="size-4 flex-none text-blue" />
                <span>{selected.size ? fill(k.selection.count, { n: n(selected.size) }) : k.selection.hint}</span>
                {selected.size > 0 && (
                  <button type="button" className="text-link text-[12px]" onClick={() => setSelected(new Map())}>
                    {k.selection.clear}
                  </button>
                )}
              </div>
              {selected.size > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {query.trash ? (
                    <button type="button" className="btn-secondary btn-sm" onClick={() => bulk('restore')}>
                      <Icon name="refresh" className="size-3.5" />
                      {k.selection.restore}
                    </button>
                  ) : (
                    <>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => bulk('move')}>
                        <Icon name="folder" className="size-3.5" />
                        {k.selection.move}
                      </button>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => bulk('reprocess')}>
                        <Icon name="refresh" className="size-3.5" />
                        {k.selection.reprocess}
                      </button>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => bulk('pause')}>
                        <Icon name="pause" className="size-3.5" />
                        {k.selection.pause}
                      </button>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => bulk('resume')}>
                        <Icon name="play" className="size-3.5" />
                        {k.selection.enable}
                      </button>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => bulk('trash')}>
                        <Icon name="trash" className="size-3.5" />
                        {k.selection.trash}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
            {data && pageSelected && selected.size < data.total && (
              <div className="border-b border-line bg-[#f7faff] px-4 py-2 text-[12px]">
                {k.selection.page}{' '}
                <button type="button" className="text-link text-[12px]" onClick={selectAllMatching} disabled={selectingAll}>
                  {selectingAll && <Spinner className="size-3" />}
                  {fill(k.selection.all, { n: n(data.total) })}
                </button>
              </div>
            )}

            {!data ? (
              <div className="flex justify-center py-16 text-muted">
                <Spinner />
              </div>
            ) : data.items.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
                <Icon name={query.trash ? 'trash' : filtered ? 'search' : 'file'} className="size-6 text-blue" />
                <strong className="text-[14px]">{query.trash ? k.trashEmpty : filtered || currentFolder !== 'all' ? k.emptyTitle : k.firstTitle}</strong>
                <p className="text-[12px] text-muted">{filtered || query.trash || currentFolder !== 'all' ? k.emptyBody : k.firstBody}</p>
                {filtered ? (
                  <button type="button" className="btn-secondary btn-sm" onClick={() => go({ q: '', kind: 'all', status: 'all', page: 1 })}>
                    {k.clearFilters}
                  </button>
                ) : (
                  !query.trash && (
                    <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
                      <Icon name="plus" />
                      {k.add}
                    </button>
                  )
                )}
              </div>
            ) : (
              <table className="w-full table-fixed text-left text-[12px]">
                <thead className="hidden border-b border-line bg-wash text-[11px] text-muted xl:table-header-group">
                  <tr>
                    <th className="w-10 py-3 pl-4">
                      <input
                        type="checkbox"
                        aria-label={k.selection.selectPage}
                        checked={pageSelected}
                        ref={(input) => {
                          if (input) input.indeterminate = somePageSelected && !pageSelected;
                        }}
                        onChange={(event) => selectPage(event.target.checked)}
                      />
                    </th>
                    <th className="px-3 py-3 font-semibold">{k.columns.name}</th>
                    <th className="w-[120px] px-3 py-3 font-semibold">{k.columns.status}</th>
                    <th className="w-[104px] px-3 py-3 font-semibold">{k.columns.enabled}</th>
                    <th className="w-[110px] px-3 py-3 font-semibold">{k.columns.size}</th>
                    <th className="hidden w-[130px] px-3 py-3 font-semibold 2xl:table-cell">{k.columns.updated}</th>
                    <th className="w-[112px] px-3 py-3 font-semibold">{k.columns.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.items.map((item) => (
                    <tr key={item.id} className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 xl:table-row xl:p-0 ${selected.has(item.id) ? 'bg-[#f7faff]' : ''}`}>
                      <td className="xl:py-3 xl:pl-4">
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
                      <td className="w-[calc(100%-40px)] min-w-0 xl:w-auto xl:px-3 xl:py-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="inline-flex size-9 flex-none items-center justify-center rounded-lg bg-soft text-blue">
                            <Icon name={KIND_ICONS[item.kind]} />
                          </span>
                          <span className="min-w-0">
                            <button
                              type="button"
                              className="block max-w-full truncate text-left text-[13px] font-semibold hover:text-blue"
                              title={item.title}
                              onClick={() => go({ preview: item.id }, { keepSelection: true })}
                            >
                              {highlight(item.title, query.q)}
                            </button>
                            <span className="block truncate text-muted">
                              {t.common.kinds[item.kind]} · {item.source ?? item.fileName ?? k.uploaded}
                            </span>
                            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                              <Icon name="folder" className="size-3" />
                              <span className="truncate">{item.folderId ? folderName(item.folderId) : k.folders.unfiled}</span>
                            </span>
                          </span>
                        </div>
                      </td>
                      <td className="xl:px-3">
                        <StatusBadge status={item.status} />
                        {item.status === 'failed' && <small className="mt-1 block text-red">{failureLabel(t, item.error)}</small>}
                      </td>
                      <td className="xl:px-3">
                        {query.trash ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <Switch checked={item.enabled} label={fill(k.toggleLabel, { title: item.title })} onChange={() => toggle(item)} />
                            <small className="text-[11px] text-muted">{item.enabled ? (item.status === 'ready' ? k.enabledLabel.on : k.enabledLabel.waiting) : k.enabledLabel.off}</small>
                          </span>
                        )}
                      </td>
                      <td className="hidden text-muted xl:table-cell xl:px-3">
                        <span className="block">{scale(item)}</span>
                        <span className="block">{fill(k.scale.chunks, { n: n(item.chunks) })}</span>
                      </td>
                      <td className="hidden text-muted xl:px-3 2xl:table-cell">{formatDateTime(item.updatedAt, locale)}</td>
                      <td className="ml-auto xl:ml-0 xl:px-3">
                        <div className="flex gap-1">
                          <Link className="btn-ghost" href={`/rees/${reeId}/knowledge/${item.id}?${libraryParams({ ...query, preview: null }).toString()}`}>
                            <Icon name="external" className="size-3.5" />
                            {k.preview}
                          </Link>
                          {query.trash ? (
                            <button type="button" className="btn-secondary btn-sm" onClick={() => setDialog({ type: 'confirm', action: 'restore', items: [actionItem(item)] })}>
                              {k.menu.restore}
                            </button>
                          ) : (
                            <button type="button" className="icon-btn" aria-label={fill(k.more, { title: item.title })} onClick={() => setDialog({ type: 'menu', item: actionItem(item) })}>
                              <Icon name="dots" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {data && data.total > 0 && (
              <div className="border-t border-line px-4 py-3">
                <Pager page={data.page} size={data.size} total={data.total} sizes={LIST_PAGE_SIZES} onPage={(pageNo) => go({ page: pageNo }, { keepSelection: true })} onSize={(size) => go({ size, page: 1 })} />
              </div>
            )}
          </section>
          <div className="mt-3 flex flex-col gap-1 text-[11px] text-muted sm:flex-row sm:justify-between">
            <span className="flex items-center gap-1.5">
              <Icon name="shield" className="size-3.5" />
              {k.note}
            </span>
            <span>{k.noteChildren}</span>
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
        onOpen={setDialog}
        onClose={() => setDialog(null)}
        onPreview={(item) => {
          setDialog(null);
          go({ preview: item.id }, { keepSelection: true });
        }}
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
        title={data?.items.find((item) => item.id === query.preview)?.title ?? k.preview}
        subtitle={
          <Link href={`/rees/${reeId}/knowledge/${query.preview}?${libraryParams({ ...query, preview: null }).toString()}`} className="text-link text-[12px]">
            <Icon name="external" className="size-3" />
            {k.preview}
          </Link>
        }
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] text-muted">{position >= 0 && fill(k.page.position, { n: n(position + 1), total: n(neighbors.length) })}</span>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary btn-sm" disabled={position <= 0} onClick={() => go({ preview: neighbors[position - 1] }, { keepSelection: true })}>
                <Icon name="chevronLeft" className="size-3.5" />
                {k.page.previous}
              </button>
              <button type="button" className="btn-secondary btn-sm" disabled={position < 0 || position >= neighbors.length - 1} onClick={() => go({ preview: neighbors[position + 1] }, { keepSelection: true })}>
                {k.page.next}
                <Icon name="chevronRight" className="size-3.5" />
              </button>
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
            <button type="button" className="btn-secondary" onClick={() => setFolderForm(null)}>
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
          <label>
            <span className="field-label">{k.folders.nameLabel}</span>
            <input
              className="input"
              value={folderForm?.name ?? ''}
              maxLength={KNOWLEDGE_FOLDER_NAME_MAX}
              placeholder={k.folders.namePlaceholder}
              required
              autoFocus
              onChange={(event) => setFolderForm((current) => (current ? { ...current, name: event.target.value } : current))}
            />
          </label>
          {folderError && (
            <p role="alert" className="mt-3 rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">
              {folderError}
            </p>
          )}
        </form>
      </Modal>

      <Modal open={Boolean(folderMenu)} onClose={() => setFolderMenu(null)} title={folderMenu?.name ?? ''} subtitle={k.folders.menuSubtitle}>
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium hover:bg-wash"
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
            className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium text-red hover:bg-wash"
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

