'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { CONVERSATION_PERIODS, LIST_PAGE_SIZES } from '@/lib/constants';
import {
  conversationSearchParams,
  dateGroup,
  highlight,
  snippet,
  type BatchAction,
  type ConversationQuery,
  type ConversationSort,
  type ConversationView,
} from '@/lib/domain/conversation';
import { conversationApi } from '@/lib/client/conversations';
import type { ConversationCounts } from '@/lib/services/conversations';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { ConfirmModal } from '@/components/ui/modal';
import { Pager } from '@/components/ui/pager';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { RowMenu } from '@/components/ui/row-menu';
import { useToast } from '@/components/ui/toast';
import { RenameDialog } from '@/components/conversations/rename-dialog';

export interface SearchItem {
  id: string;
  title: string;
  pinned: boolean;
  archivedAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
  questions: number;
  matched: string | null;
  participants: { id: string; name: string; avatarBlob: string | null; color: string }[];
}

const VIEWS: { key: ConversationView; icon: 'search' | 'chat' | 'pin' | 'archive' | 'trash' }[] = [
  { key: 'all', icon: 'search' },
  { key: 'recent', icon: 'chat' },
  { key: 'pinned', icon: 'pin' },
  { key: 'archived', icon: 'archive' },
  { key: 'trash', icon: 'trash' },
];

function Marked({ text, q }: { text: string; q: string }) {
  return (
    <>
      {highlight(text, q).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rounded-sm bg-[#fff2b8] px-px text-ink">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/**
 * `/chats` (prototype conversations.js): a large search box over titles,
 * message text and Ree names, with the Ree, time and sort filters always
 * shown; 全部 / 最近 / 置顶 / 归档 / 回收站 tabs whose counts follow the search;
 * results grouped by day, matches marked; a menu per row; and a selection
 * mode for batch pin, archive, trash and restore -- across pages too. Every
 * condition lives in the URL, so refresh and back / forward restore it.
 */
export function ConversationSearch({
  query,
  result,
  rees,
  focus,
}: {
  query: ConversationQuery;
  result: { items: SearchItem[]; total: number; page: number; size: number; counts: ConversationCounts };
  rees: { id: string; name: string }[];
  focus: boolean;
}) {
  const { t, locale } = useI18n();
  const s = t.conversations.search;
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [q, setQ] = useState(query.q);
  const [pending, startTransition] = useTransition();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ action: BatchAction; ids: string[] } | null>(null);
  const [renaming, setRenaming] = useState<SearchItem | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const typed = useRef(false);

  useEffect(() => {
    if (focus) box.current?.focus();
  }, [focus]);

  /* The URL is the source of truth: back / forward and refresh bring the controls back to it. */
  useEffect(() => {
    if (!typed.current) setQ(query.q);
    typed.current = false;
  }, [query.q]);

  useEffect(() => setSelected(new Set()), [query.view, query.q, query.ree, query.days, query.sort]);

  const go = (changes: Partial<ConversationQuery>, replace = false) => {
    const next = { ...query, ...changes };
    if (!('page' in changes)) next.page = 1;
    const params = conversationSearchParams(next);
    const href = params.size ? `${pathname}?${params}` : pathname;
    startTransition(() => (replace ? router.replace(href, { scroll: false }) : router.push(href, { scroll: false })));
  };

  /* Live search: results follow the box as you type, without piling up history entries. */
  useEffect(() => {
    if (q === query.q) return;
    const timer = setTimeout(() => {
      typed.current = true;
      go({ q: q.trim() }, true);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const filtered = Boolean(query.q || query.ree || query.days);
  const pageIds = result.items.map((item) => item.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const chosen = result.items.filter((item) => selected.has(item.id));
  const selfPath = (() => {
    const params = conversationSearchParams(query);
    return params.size ? `/chats?${params}` : '/chats';
  })();

  const run = async (action: BatchAction, ids: string[]) => {
    try {
      const { changed } = await conversationApi.batch(action, ids);
      setSelected(new Set());
      toast(action === 'trash' ? s.trashed : action === 'restore' ? fill(s.restored, { n: changed }) : fill(s.changed, { n: changed }));
      router.refresh();
    } catch {
      toast(t.common.errors.generic);
    }
  };

  const ask = (action: BatchAction, ids: string[]) => {
    if (action === 'archive' || action === 'unarchive' || action === 'trash') setConfirm({ action, ids });
    else void run(action, ids);
  };

  const now = new Date();
  let previousGroup = '';
  const groupOf = (item: SearchItem) => {
    if (item.pinned && query.view === 'recent' && query.sort === 'new') return s.groups.pinned;
    if (query.q) return s.groups.results;
    if (query.sort === 'title') return s.groups.all;
    if (query.view === 'pinned') return s.groups.pinned;
    return s.groups[dateGroup(new Date(query.view === 'trash' ? item.deletedAt ?? item.updatedAt : item.updatedAt), now)];
  };

  const dateLabel = (value: string) =>
    new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-GB', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));

  return (
    <main className="mx-auto w-full max-w-[1000px] px-4 pt-6 pb-16 md:px-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <span className="eyebrow">{s.eyebrow}</span>
          <h1 className="mt-2 text-[26px] font-extrabold tracking-tight">{s.title}</h1>
          <p className="mt-1 text-[13px] text-muted">{s.body}</p>
        </div>
        <span className="hidden size-12 items-center justify-center rounded-2xl bg-soft text-blue sm:inline-flex" aria-hidden="true">
          <Icon name="search" className="size-6" />
        </span>
      </header>

      <section className="card mt-6 p-4" aria-label={s.label}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            go({ q: q.trim() });
          }}
        >
          <div className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 focus-within:border-blue">
            <Icon name="search" className="size-4 flex-none text-muted" />
            <input
              ref={box}
              id="conversation-search"
              type="search"
              name="q"
              value={q}
              maxLength={200}
              autoComplete="off"
              placeholder={s.placeholder}
              aria-label={s.label}
              className="h-11 min-w-0 flex-1 bg-transparent text-[14px] outline-none"
              onChange={(event) => setQ(event.target.value)}
            />
            {q && (
              <button
                type="button"
                className="icon-btn"
                aria-label={s.clear}
                onClick={() => {
                  setQ('');
                  go({ q: '' }, true);
                  box.current?.focus();
                }}
              >
                <Icon name="close" />
              </button>
            )}
            <button type="submit" className="btn btn-sm hidden sm:inline-flex">
              {s.submit}
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Select label={s.ree} value={query.ree ?? ''} onChange={(value) => go({ ree: value || null })} options={[['', s.allRees], ...rees.map((ree) => [ree.id, ree.name] as [string, string])]} />
            <Select
              label={s.updated}
              value={query.days ? String(query.days) : ''}
              onChange={(value) => go({ days: value ? Number(value) : null })}
              options={[['', s.anyTime], ...CONVERSATION_PERIODS.map((days) => [String(days), fill(s.days, { n: days })] as [string, string])]}
            />
            <Select label={s.sort} value={query.sort} onChange={(value) => go({ sort: value as ConversationSort })} options={(['new', 'old', 'title'] as const).map((sort) => [sort, s.sorts[sort]])} />
          </div>
        </form>
      </section>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label={s.viewsLabel} className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          {VIEWS.map((view) => (
            <button
              key={view.key}
              type="button"
              aria-pressed={query.view === view.key}
              onClick={() => go({ view: view.key })}
              className={`flex h-9 flex-none items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium ${query.view === view.key ? 'bg-ink text-white' : 'bg-white text-[#3b4361] hover:bg-soft'}`}
            >
              <Icon name={view.icon} className="size-3.5" />
              {s.views[view.key]}
              <span className={`font-mono text-[10px] ${query.view === view.key ? 'text-white/70' : 'text-muted'}`}>{formatNumber(result.counts[view.key], locale)}</span>
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="btn-ghost"
          aria-pressed={selecting}
          onClick={() => {
            setSelecting((value) => !value);
            setSelected(new Set());
          }}
        >
          <Icon name="check" />
          {selecting ? s.done : s.select}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted" aria-live="polite">
        <span role="status">
          {filtered ? fill(s.found, { n: formatNumber(result.total, locale) }) : `${fill(s.total, { n: formatNumber(result.total, locale) })}${query.view === 'all' ? s.includesArchived : ''}`}
        </span>
        {filtered && (
          <button
            type="button"
            className="text-blue hover:underline"
            onClick={() => {
              setQ('');
              go({ q: '', ree: null, days: null });
            }}
          >
            {s.reset}
          </button>
        )}
        {pending && <Spinner className="size-3.5" />}
      </div>

      <section className="card mt-3 overflow-hidden" aria-label={s.label}>
        {(selecting || selected.size > 0) && (
          <div className={`flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 text-[12px] ${selected.size ? 'bg-soft' : 'bg-wash'}`}>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={s.selectPageLabel}
                  checked={allOnPage}
                  disabled={!pageIds.length}
                  ref={(node) => {
                    if (node) node.indeterminate = !allOnPage && pageIds.some((id) => selected.has(id));
                  }}
                  onChange={(event) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      for (const id of pageIds) {
                        if (event.target.checked) next.add(id);
                        else next.delete(id);
                      }
                      return next;
                    })
                  }
                />
                {s.selectPage}
              </label>
              <span>{selected.size ? fill(s.selected, { n: selected.size }) : s.hint}</span>
              {selected.size > 0 && (
                <button type="button" className="text-blue hover:underline" onClick={() => setSelected(new Set())}>
                  {s.clearSelection}
                </button>
              )}
            </div>
            {selected.size > 0 && (
              <div className="flex flex-wrap gap-2">
                {query.view === 'trash' ? (
                  <button type="button" className="btn-secondary btn-sm" onClick={() => ask('restore', [...selected])}>
                    <Icon name="refresh" className="size-3.5" />
                    {s.restore}
                  </button>
                ) : (
                  <>
                    {query.view !== 'archived' && (
                      <button type="button" className="btn-secondary btn-sm" onClick={() => ask(chosen.length && chosen.every((item) => item.pinned) ? 'unpin' : 'pin', [...selected])}>
                        <Icon name="pin" className="size-3.5" />
                        {chosen.length && chosen.every((item) => item.pinned) ? s.unpin : s.pin}
                      </button>
                    )}
                    <button type="button" className="btn-secondary btn-sm" onClick={() => ask(query.view === 'archived' ? 'unarchive' : 'archive', [...selected])}>
                      <Icon name="archive" className="size-3.5" />
                      {query.view === 'archived' ? s.unarchive : s.archive}
                    </button>
                    <button type="button" className="btn-secondary btn-sm !text-red" onClick={() => ask('trash', [...selected])}>
                      <Icon name="trash" className="size-3.5" />
                      {s.trash}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {allOnPage && selected.size < result.total && (
          <div className="border-b border-line bg-wash px-4 py-2 text-[12px]">
            {s.pageSelected}{' '}
            <button
              type="button"
              className="text-blue hover:underline"
              onClick={async () => {
                const { ids } = await conversationApi.ids(conversationSearchParams({ ...query, page: 1 }));
                setSelected(new Set(ids));
              }}
            >
              {fill(s.selectAll, { n: formatNumber(result.total, locale) })}
            </button>
          </div>
        )}

        {result.items.length === 0 ? (
          <Empty view={query.view} filtered={filtered} onReset={() => go({ q: '', ree: null, days: null })} onRecent={() => go({ view: 'recent' })} />
        ) : (
          <div className="divide-y divide-line">
            {result.items.map((item) => {
              const group = groupOf(item);
              const heading = group !== previousGroup ? <h2 className="bg-wash px-4 py-1.5 text-[11px] font-semibold text-muted">{group}</h2> : null;
              previousGroup = group;
              const trash = query.view === 'trash';
              const title = item.title || t.conversations.sidebar.untitled;
              const main = (
                <>
                  <span className="flex min-w-0 items-center gap-2">
                    {item.pinned && !trash && <Icon name="pin" className="size-3.5 flex-none text-muted" />}
                    <strong className="truncate text-[14px]">
                      <Marked text={title} q={query.q} />
                    </strong>
                    {item.archivedAt && !trash && <span className="tag flex-none">{s.archivedLabel}</span>}
                  </span>
                  <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted">
                    <span className="flex -space-x-1.5">
                      {item.participants.slice(0, 3).map((ree) => (
                        <ReeAvatar key={ree.id} avatar={ree.avatarBlob} color={ree.color} size="sm" className="!size-5 !rounded-full ring-2 ring-white [&_svg]:!size-3" />
                      ))}
                    </span>
                    <span className="min-w-0 truncate">
                      {item.participants.length ? (
                        item.participants.map((ree, index) => (
                          <span key={ree.id}>
                            {index > 0 && ' · '}
                            <Marked text={ree.name} q={query.q} />
                          </span>
                        ))
                      ) : (
                        s.noParticipants
                      )}
                    </span>
                    <span>· {fill(s.questions, { n: item.questions })}</span>
                    <span className="sm:hidden">· {dateLabel(trash ? item.deletedAt ?? item.updatedAt : item.updatedAt)}</span>
                  </span>
                  {query.q && item.matched && (
                    <p className="mt-1.5 line-clamp-2 text-[12px] text-[#3b4361]">
                      <span className="mr-1.5 rounded bg-soft px-1 py-px text-[10px] font-semibold text-blue">{s.matchLabel}</span>
                      <Marked text={snippet(item.matched, query.q)} q={query.q} />
                    </p>
                  )}
                </>
              );
              return (
                <div key={item.id}>
                  {heading}
                  <article className={`flex items-center gap-3 px-4 py-3 ${selected.has(item.id) ? 'bg-soft' : 'hover:bg-wash'}`}>
                    {(selecting || selected.size > 0) && (
                      <input
                        type="checkbox"
                        aria-label={`${s.selectOne}: ${title}`}
                        checked={selected.has(item.id)}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(item.id);
                            else next.delete(item.id);
                            return next;
                          })
                        }
                      />
                    )}
                    {trash ? (
                      <div className="min-w-0 flex-1">{main}</div>
                    ) : (
                      <Link href={`/chats/${item.id}?from=${encodeURIComponent(selfPath)}`} className="min-w-0 flex-1">
                        {main}
                      </Link>
                    )}
                    <time className="hidden flex-none font-mono text-[11px] text-muted sm:block" dateTime={item.updatedAt}>
                      {dateLabel(trash ? item.deletedAt ?? item.updatedAt : item.updatedAt)}
                    </time>
                    {trash ? (
                      <button type="button" className="icon-btn" aria-label={fill(s.restoreOne, { title })} title={fill(s.restoreOne, { title })} onClick={() => ask('restore', [item.id])}>
                        <Icon name="refresh" />
                      </button>
                    ) : (
                      <RowMenu
                        label={fill(s.menu, { title })}
                        items={[
                          {
                            label: s.selectOne,
                            icon: 'check',
                            onSelect: () => {
                              setSelecting(true);
                              setSelected((current) => new Set(current).add(item.id));
                            },
                          },
                          { label: s.rename, icon: 'settings', onSelect: () => setRenaming(item) },
                          ...(!item.archivedAt ? [{ label: item.pinned ? s.unpin : s.pinOne, icon: 'pin' as const, onSelect: () => ask(item.pinned ? 'unpin' : 'pin', [item.id]) }] : []),
                          { label: item.archivedAt ? s.unarchive : s.archiveOne, icon: 'archive', onSelect: () => ask(item.archivedAt ? 'unarchive' : 'archive', [item.id]) },
                          { label: s.trash, icon: 'trash', danger: true, onSelect: () => ask('trash', [item.id]) },
                        ]}
                      />
                    )}
                  </article>
                </div>
              );
            })}
          </div>
        )}
        <footer className="border-t border-line px-4 py-3">
          <Pager page={result.page} size={result.size} total={result.total} sizes={LIST_PAGE_SIZES} onPage={(page) => go({ page })} onSize={(size) => go({ size })} />
        </footer>
      </section>
      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted">
        <Icon name="shield" className="size-3.5" />
        {s.note}
      </p>

      <ConfirmModal
        open={Boolean(confirm)}
        danger={confirm?.action === 'trash'}
        title={confirm?.action === 'trash' ? fill(s.trashTitle, { n: confirm.ids.length }) : confirm?.action === 'unarchive' ? s.unarchiveTitle : s.archiveTitle}
        body={confirm?.action === 'trash' ? s.trashBody : s.archiveBody}
        confirmLabel={confirm?.action === 'trash' ? s.trash : confirm?.action === 'unarchive' ? s.unarchive : s.archive}
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          const current = confirm;
          setConfirm(null);
          if (current) await run(current.action, current.ids);
        }}
      />
      <RenameDialog
        open={Boolean(renaming)}
        initial={renaming?.title ?? ''}
        onClose={() => setRenaming(null)}
        onSave={async (title) => {
          if (!renaming) return;
          await conversationApi.update(renaming.id, { title });
          setRenaming(null);
          toast(t.conversations.room.renamed);
          router.refresh();
        }}
      />
    </main>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-muted">
      {label}
      <select className="h-9 min-w-0 rounded-lg border border-line bg-white px-2 text-[12px] font-normal text-ink" value={value} aria-label={label} onChange={(event) => onChange(event.target.value)}>
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function Empty({ view, filtered, onReset, onRecent }: { view: ConversationView; filtered: boolean; onReset: () => void; onRecent: () => void }) {
  const { t } = useI18n();
  const e = t.conversations.search.empty;
  const [title, body] = filtered
    ? [e.filtered, e.filteredBody]
    : view === 'pinned'
      ? [e.pinned, e.pinnedBody]
      : view === 'archived'
        ? [e.archived, e.archivedBody]
        : view === 'trash'
          ? [e.trash, e.trashBody]
          : [e.all, e.allBody];
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <Icon name={filtered ? 'search' : view === 'archived' ? 'archive' : view === 'trash' ? 'trash' : 'chat'} className="size-7 text-[#a3a9bb]" />
      <h2 className="mt-4 text-[16px] font-bold">{title}</h2>
      <p className="mt-1 text-[12px] text-muted">{body}</p>
      <div className="mt-5">
        {filtered ? (
          <button type="button" className="btn-secondary" onClick={onReset}>
            {t.conversations.search.reset}
          </button>
        ) : view === 'all' || view === 'recent' ? (
          <Link href="/talk" className="btn">
            {e.start}
          </Link>
        ) : (
          <button type="button" className="btn-secondary" onClick={onRecent}>
            {e.recent}
          </button>
        )}
      </div>
    </div>
  );
}
