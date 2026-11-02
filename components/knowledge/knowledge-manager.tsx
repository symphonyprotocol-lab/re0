'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import type { KnowledgeListItem, KnowledgeTab } from '@/lib/services/knowledge';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { formatDateTime, formatNumber } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { Pager } from '@/components/ui/pager';
import { useToast } from '@/components/ui/toast';
import { AddKnowledgeModal } from '@/components/knowledge/add-knowledge';
import { KnowledgePreview } from '@/components/knowledge/knowledge-preview';
import { StatusBadge, failureLabel } from '@/components/knowledge/status-badge';

interface ListResponse {
  items: KnowledgeListItem[];
  total: number;
  page: number;
  size: number;
  counts: Record<KnowledgeTab, number>;
}

const TABS: KnowledgeTab[] = ['all', 'ready', 'processing', 'failed'];

/**
 * `/rees/[id]/knowledge`: status tabs, search, type filter, sort and paging,
 * all in the URL and done by the server; rows still processing are polled
 * until they settle. Folders, bulk actions and trash are step 2.
 */
export function KnowledgeManager({ reeId }: { reeId: string }) {
  const { t, locale } = useI18n();
  const k = t.knowledge;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const toast = useToast();
  const query = {
    q: search.get('q') ?? '',
    status: (TABS as string[]).includes(search.get('status') ?? '') ? (search.get('status') as KnowledgeTab) : 'all',
    kind: ['document', 'text'].includes(search.get('kind') ?? '') ? search.get('kind')! : 'all',
    sort: ['recent', 'oldest', 'name'].includes(search.get('sort') ?? '') ? search.get('sort')! : 'recent',
    size: (LIST_PAGE_SIZES as readonly number[]).includes(Number(search.get('size'))) ? Number(search.get('size')) : 20,
    page: Math.max(1, Number(search.get('page')) || 1),
    preview: search.get('preview'),
  };
  const [data, setData] = useState<ListResponse | null>(null);
  const [q, setQ] = useState(query.q);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const searchKey = search.toString();

  const go = (changes: Partial<typeof query>) => {
    const next = { ...query, ...changes };
    const params = new URLSearchParams();
    if (next.q) params.set('q', next.q);
    if (next.status !== 'all') params.set('status', next.status);
    if (next.kind !== 'all') params.set('kind', next.kind);
    if (next.sort !== 'recent') params.set('sort', next.sort);
    if (next.size !== 20) params.set('size', String(next.size));
    if (next.page > 1) params.set('page', String(next.page));
    if (next.preview) params.set('preview', next.preview);
    const value = params.toString();
    router.push(value ? `${pathname}?${value}` : pathname, { scroll: false });
  };

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

  const busy = data?.items.some((item) => item.status === 'pending' || item.status === 'processing') ?? false;
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

  const refresh = async (id: string) => {
    setRefreshing(id);
    const result = await api<{ error?: string }>(`/api/rees/${reeId}/knowledge/${id}/refresh`, { method: 'POST' });
    setRefreshing(null);
    if (!result.ok) {
      const code = result.data.error as keyof typeof k.errors | undefined;
      toast(code && code in k.errors ? k.errors[code] : t.common.errors.generic);
      return;
    }
    await load();
    router.refresh();
  };

  const n = (value: number) => formatNumber(value, locale);
  const filtered = Boolean(query.q) || query.kind !== 'all' || query.status !== 'all';

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-8 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">{k.eyebrow}</p>
          <h1 className="mt-2 flex items-baseline gap-2 text-[28px] font-extrabold tracking-tight">
            {k.title}
            <span className="font-mono text-[14px] font-medium text-muted">{data ? n(data.counts.all) : ''}</span>
          </h1>
          <p className="mt-2 text-[13px] text-muted">{k.lede}</p>
        </div>
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          <Icon name="plus" />
          {k.add}
        </button>
      </div>

      <div className="mt-6 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={query.status === tab}
            onClick={() => go({ status: tab, page: 1 })}
            className={`flex flex-none items-center gap-1.5 border-b-2 px-3 py-2.5 text-[12px] font-semibold whitespace-nowrap ${
              query.status === tab ? 'border-blue text-blue' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {k.tabs[tab]}
            <span className="rounded-full bg-wash px-1.5 font-mono text-[10px]">{data ? n(data.counts[tab]) : '–'}</span>
          </button>
        ))}
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
          <input className="input pl-9" type="search" value={q} placeholder={k.search} onChange={(event) => setQ(event.target.value)} />
        </label>
        <div className="flex gap-2">
          <select className="input sm:w-[150px]" aria-label={k.kindLabel} value={query.kind} onChange={(event) => go({ kind: event.target.value, page: 1 })}>
            <option value="all">{k.kindAll}</option>
            <option value="document">{t.common.kinds.document}</option>
            <option value="text">{t.common.kinds.text}</option>
          </select>
          <select className="input sm:w-[150px]" aria-label={k.sortLabel} value={query.sort} onChange={(event) => go({ sort: event.target.value, page: 1 })}>
            {(['recent', 'oldest', 'name'] as const).map((sort) => (
              <option key={sort} value={sort}>
                {k.sorts[sort]}
              </option>
            ))}
          </select>
        </div>
      </form>

      <div className="card mt-4 overflow-hidden">
        {!data ? (
          <div className="flex justify-center py-16 text-muted">
            <Spinner />
          </div>
        ) : data.items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
            <Icon name={filtered ? 'search' : 'file'} className="size-6 text-blue" />
            <strong className="text-[14px]">{filtered ? k.emptyTitle : k.firstTitle}</strong>
            <p className="text-[12px] text-muted">{filtered ? k.emptyBody : k.firstBody}</p>
            {filtered ? (
              <button type="button" className="btn-secondary btn-sm" onClick={() => go({ q: '', kind: 'all', status: 'all', page: 1 })}>
                {t.common.actions.clear}
              </button>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}>
                <Icon name="plus" />
                {k.add}
              </button>
            )}
          </div>
        ) : (
          <table className="w-full table-fixed text-left text-[12px]">
            <thead className="hidden border-b border-line bg-wash text-[11px] text-muted md:table-header-group">
              <tr>
                <th className="px-4 py-3 font-semibold">{k.columns.name}</th>
                <th className="w-[150px] px-3 py-3 font-semibold">{k.columns.status}</th>
                <th className="w-[130px] px-3 py-3 font-semibold">{k.columns.size}</th>
                <th className="w-[140px] px-3 py-3 font-semibold">{k.columns.updated}</th>
                <th className="w-[150px] px-3 py-3 font-semibold">{k.columns.actions}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.items.map((item) => (
                <tr key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 md:table-row md:p-0">
                  <td className="w-full min-w-0 md:w-auto md:px-4 md:py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="inline-flex size-9 flex-none items-center justify-center rounded-lg bg-soft text-blue">
                        <Icon name={item.kind === 'text' ? 'text' : 'file'} />
                      </span>
                      <span className="min-w-0">
                        <button type="button" className="block max-w-full truncate text-left text-[13px] font-semibold hover:text-blue" title={item.title} onClick={() => go({ preview: item.id })}>
                          {item.title}
                        </button>
                        <span className="block truncate text-muted">
                          {t.common.kinds[item.kind]} · {item.fileName ?? k.uploaded}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className="md:px-3">
                    <StatusBadge status={item.status} />
                    {item.status === 'failed' && <small className="mt-1 block text-red">{failureLabel(t, item.error)}</small>}
                  </td>
                  <td className="text-muted md:px-3">
                    <span className="block">
                      {n(item.chars)} {t.common.units.chars}
                    </span>
                    <span className="block">
                      {n(item.chunks)} {t.common.units.chunks}
                    </span>
                  </td>
                  <td className="text-muted md:px-3">{formatDateTime(item.updatedAt, locale)}</td>
                  <td className="ml-auto md:ml-0 md:px-3">
                    <div className="flex gap-1">
                      <button type="button" className="btn-ghost" onClick={() => go({ preview: item.id })}>
                        <Icon name="external" className="size-3.5" />
                        {k.preview}
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={k.refresh}
                        title={k.refresh}
                        disabled={item.status === 'pending' || item.status === 'processing' || refreshing === item.id}
                        onClick={() => refresh(item.id)}
                      >
                        {refreshing === item.id ? <Spinner className="size-3.5" /> : <Icon name="refresh" />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.total > 0 && (
          <div className="border-t border-line px-4 py-3">
            <Pager page={data.page} size={data.size} total={data.total} sizes={LIST_PAGE_SIZES} onPage={(page) => go({ page })} onSize={(size) => go({ size, page: 1 })} />
          </div>
        )}
      </div>

      <AddKnowledgeModal
        open={adding}
        reeId={reeId}
        onClose={() => setAdding(false)}
        onAdded={async () => {
          setAdding(false);
          toast(k.addModal.added);
          await load();
          router.refresh();
        }}
      />
      <KnowledgePreview reeId={reeId} knowledgeId={query.preview} onClose={() => go({ preview: null })} onRefresh={refresh} />
    </main>
  );
}
