'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState, useTransition } from 'react';
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
import { useToast } from '@/components/ui/toast';
import { Avatar, I, useNavigationHeight } from '@/components/chat/message-parts';
import { ConversationMenu } from '@/components/conversations/conversation-menu';
import { RenameDialog } from '@/components/conversations/rename-dialog';
import { OrganizeConfirm, type OrganizeRequest } from '@/components/conversations/organize-confirm';
import { TrashPreview } from '@/components/conversations/trash-preview';

export interface SearchItem {
  id: string;
  title: string;
  pinned: boolean;
  archivedAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
  questions: number;
  matched: string | null;
  latest: string | null;
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
          <mark key={index}>{segment.text}</mark>
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
  select,
}: {
  query: ConversationQuery;
  result: { items: SearchItem[]; total: number; page: number; size: number; counts: ConversationCounts };
  rees: { id: string; name: string }[];
  focus: boolean;
  /** "选择此对话" from the sidebar: open in selection mode with this one checked. */
  select: string | null;
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
  const [confirm, setConfirm] = useState<OrganizeRequest | null>(null);
  const [renaming, setRenaming] = useState<SearchItem | null>(null);
  const [previewing, setPreviewing] = useState<SearchItem | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const typed = useRef(false);
  const page = useRef<HTMLDivElement>(null);
  useNavigationHeight(page);

  useEffect(() => {
    if (focus) box.current?.focus();
  }, [focus]);

  /* The URL is the source of truth: back / forward and refresh bring the controls back to it. */
  useEffect(() => {
    if (!typed.current) setQ(query.q);
    typed.current = false;
  }, [query.q]);

  useEffect(() => setSelected(new Set()), [query.view, query.q, query.ree, query.days, query.sort]);

  /* The page actually shown: a page past the end is clamped by the server. */
  const shown = { ...query, page: result.page };
  const hrefOf = (next: ConversationQuery) => {
    const params = conversationSearchParams(next);
    return params.size ? `${pathname}?${params}` : pathname;
  };

  /* "选择此对话" from the sidebar arrives as `?select=<id>`; an out-of-range page as itself: both settle on the canonical URL. */
  useEffect(() => {
    if (select) {
      setSelecting(true);
      setSelected(new Set([select]));
    }
    if (select || result.page !== query.page) router.replace(hrefOf(shown), { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [select, result.page, query.page]);

  const go = (changes: Partial<ConversationQuery>, replace = false) => {
    const next = { ...shown, ...changes };
    if (!('page' in changes)) next.page = 1;
    const href = hrefOf(next);
    /* A new page or page size starts at the top (prototype conversations.js `cl-page` / `cl-size`); other changes keep the place. */
    const toTop = 'page' in changes || 'size' in changes;
    startTransition(() => (replace ? router.replace(href, { scroll: false }) : router.push(href, { scroll: false })));
    if (toTop) window.scrollTo({ top: 0, behavior: 'instant' });
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
    const params = conversationSearchParams(shown);
    return params.size ? `/chats?${params}` : '/chats';
  })();

  const run = async (action: BatchAction, ids: string[]) => {
    try {
      const { changed } = await conversationApi.batch(action, ids);
      setSelected(new Set());
      toast(
        action === 'trash'
          ? s.trashed
          : action === 'restore'
            ? fill(s.restored, { n: changed })
            : action === 'pin'
              ? s.pinnedToast
              : action === 'unpin'
                ? s.unpinnedToast
                : fill(s.changed, { n: changed }),
      );
      router.refresh();
    } catch {
      toast(t.common.errors.generic);
    }
  };

  const ask = (action: BatchAction, ids: string[]) => {
    if (action === 'archive' || action === 'unarchive' || action === 'trash') {
      const titles = result.items.filter((item) => ids.includes(item.id)).map((item) => item.title || t.conversations.sidebar.untitled);
      setConfirm({ action, ids, titles });
    } else void run(action, ids);
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

  const pages = Math.max(1, Math.ceil(result.total / result.size));
  const from = result.total ? (result.page - 1) * result.size + 1 : 0;
  const to = Math.min(result.page * result.size, result.total);
  const isSelecting = selecting || selected.size > 0;
  const togglePage = (on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of pageIds) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  return (
    <div ref={page} className={`cl-page cl-search-page filters-open${isSelecting ? ' is-selecting' : ''}`}>
      <header className="cl-search-page-head">
        <div>
          <p className="eyebrow">{s.eyebrow}</p>
          <h1>{s.title}</h1>
          <p>{s.body}</p>
        </div>
        <span className="cl-search-page-icon" aria-hidden="true">
          <I name="search" />
        </span>
      </header>

      <section className="card cl-search-hero" aria-label={s.filtersLabel}>
        <form
          className="cl-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            go({ q: q.trim() });
          }}
        >
          <div className="cl-search-input">
            <I name="search" />
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
              onChange={(event) => setQ(event.target.value)}
            />
            <button
              type="button"
              className="icon-btn cl-search-clear"
              aria-label={s.clear}
              onClick={() => {
                setQ('');
                go({ q: '' }, true);
                box.current?.focus();
              }}
            >
              <I name="close" />
            </button>
            <button type="submit" className="btn">
              {s.submit}
            </button>
          </div>
          <div className="cl-search-facets">
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

      <div className="cl-search-results-bar">
        <div className="cl-tabs-wrap">
          <nav className="cl-tabs" aria-label={s.viewsLabel}>
            {VIEWS.map((view) => (
              <button key={view.key} type="button" className={`cl-tab${query.view === view.key ? ' active' : ''}`} aria-pressed={query.view === view.key} onClick={() => go({ view: view.key })}>
                <I name={view.icon} />
                {s.views[view.key]}
                <span>{formatNumber(result.counts[view.key], locale)}</span>
              </button>
            ))}
          </nav>
        </div>
        <button
          type="button"
          className="btn ghost cl-select-mode"
          aria-pressed={isSelecting}
          onClick={() => {
            setSelecting(!isSelecting);
            setSelected(new Set());
          }}
        >
          <I name="check" />
          {s.select}
        </button>
      </div>

      <div className="cl-filter-summary" aria-live="polite">
        <span role="status">
          {filtered ? fill(s.found, { n: formatNumber(result.total, locale) }) : `${fill(s.total, { n: formatNumber(result.total, locale) })}${query.view === 'all' ? s.includesArchived : ''}`}
          {pending && <i className="spinner" style={{ width: 9, height: 9, marginLeft: 8, verticalAlign: 'middle' }} />}
        </span>
        {filtered && (
          <button
            type="button"
            className="text-link"
            onClick={() => {
              setQ('');
              go({ q: '', ree: null, days: null });
            }}
          >
            {s.reset}
          </button>
        )}
      </div>

      <section className="card cl-results" aria-label={s.resultsLabel}>
        <div className={`cl-selection${selected.size ? ' active' : ''}`}>
          <div className="p-flex">
            <I name={selected.size ? 'check' : 'info'} />
            <span>{selected.size ? fill(s.selected, { n: selected.size }) : s.hint}</span>
            {selected.size > 0 && (
              <button type="button" className="text-link" onClick={() => setSelected(new Set())}>
                {s.clearSelection}
              </button>
            )}
          </div>
          <div className="cl-bulk-actions">
            {selected.size > 0 &&
              (query.view === 'trash' ? (
                <button type="button" className="btn secondary sm" onClick={() => ask('restore', [...selected])}>
                  <I name="refresh" />
                  {s.restore}
                </button>
              ) : (
                <>
                  {query.view !== 'archived' && (
                    <button type="button" className="btn secondary sm" onClick={() => ask(chosen.length && chosen.every((item) => item.pinned) ? 'unpin' : 'pin', [...selected])}>
                      <I name="pin" />
                      {chosen.length && chosen.every((item) => item.pinned) ? s.unpin : s.pin}
                    </button>
                  )}
                  <button type="button" className="btn secondary sm" onClick={() => ask(query.view === 'archived' ? 'unarchive' : 'archive', [...selected])}>
                    <I name="archive" />
                    {query.view === 'archived' ? s.unarchive : s.archive}
                  </button>
                  <button type="button" className="btn secondary sm" onClick={() => ask('trash', [...selected])}>
                    <I name="trash" />
                    {s.trash}
                  </button>
                </>
              ))}
          </div>
        </div>
        {allOnPage && selected.size < result.total && (
          <div className="cl-select-all">
            {s.pageSelected}
            <button
              type="button"
              className="text-link"
              onClick={async () => {
                const { ids } = await conversationApi.ids(conversationSearchParams({ ...query, page: 1 }));
                setSelected(new Set(ids));
              }}
            >
              {fill(s.selectAll, { n: formatNumber(result.total, locale) })}
            </button>
          </div>
        )}
        <div className="cl-selection-options">
          <label>
            <input
              type="checkbox"
              className="cl-select-page"
              aria-label={s.selectPageLabel}
              checked={allOnPage}
              disabled={!pageIds.length}
              ref={(node) => {
                if (node) node.indeterminate = !allOnPage && pageIds.some((id) => selected.has(id));
              }}
              onChange={(event) => togglePage(event.target.checked)}
            />
            {s.selectPage}
          </label>
          <button
            type="button"
            className="text-link"
            onClick={() => {
              setSelecting(false);
              setSelected(new Set());
            }}
          >
            {s.done}
          </button>
        </div>

        <div className="cl-scroll">
          {result.items.length === 0 ? (
            <Empty view={query.view} filtered={filtered} onReset={() => go({ q: '', ree: null, days: null })} onRecent={() => go({ view: 'recent' })} />
          ) : (
            result.items.map((item) => {
              const group = groupOf(item);
              const heading = group !== previousGroup ? <h2 className="cl-date-group">{group}</h2> : null;
              previousGroup = group;
              const trash = query.view === 'trash';
              const title = item.title || t.conversations.sidebar.untitled;
              const date = dateLabel(trash ? item.deletedAt ?? item.updatedAt : item.updatedAt);
              const main = (
                <>
                  <div className="cl-row-title">
                    <strong>
                      <Marked text={title} q={query.q} />
                    </strong>
                    {item.archivedAt && !trash && <span className="cl-archive-label">{s.archivedLabel}</span>}
                  </div>
                  <div className="cl-conversation-meta">
                    <span className="cl-mini-dots">
                      {item.participants.slice(0, 3).map((ree) => (
                        <Avatar key={ree.id} ree={ree} sm />
                      ))}
                    </span>
                    <span className="cl-dot-names">
                      {item.participants.length
                        ? item.participants.map((ree, index) => (
                            <Fragment key={ree.id}>
                              {index > 0 && ' · '}
                              <Marked text={ree.name} q={query.q} />
                            </Fragment>
                          ))
                        : s.noParticipants}
                    </span>
                    <span>·</span>
                    <span>{fill(s.questions, { n: item.questions })}</span>
                    <span className="cl-inline-date">· {date}</span>
                  </div>
                  {query.q && (
                    <p className="cl-snippet">
                      {item.matched ? (
                        <>
                          <span className="cl-match-label">{s.matchLabel}</span>
                          <Marked text={snippet(item.matched, query.q)} q={query.q} />
                        </>
                      ) : item.latest ? (
                        <Marked text={snippet(item.latest, query.q)} q={query.q} />
                      ) : (
                        <span className="cl-no-message">{s.noMessages}</span>
                      )}
                    </p>
                  )}
                </>
              );
              return (
                <Fragment key={item.id}>
                  {heading}
                  <article className={`cl-row${selected.has(item.id) ? ' selected' : ''}`}>
                    <label className="cl-check">
                      <input
                        type="checkbox"
                        aria-label={`${s.selectPrefix}${title}`}
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
                    </label>
                    {trash ? (
                      <button type="button" className="cl-main" aria-haspopup="dialog" onClick={() => setPreviewing(item)}>
                        {main}
                      </button>
                    ) : (
                      <Link href={`/chats/${item.id}?from=${encodeURIComponent(selfPath)}`} className="cl-main">
                        {main}
                      </Link>
                    )}
                    <time className="cl-time" dateTime={item.updatedAt} title={item.updatedAt}>
                      {date}
                    </time>
                    <div className="cl-row-actions">
                      {trash ? (
                        <button type="button" className="icon-btn" aria-label={fill(s.restoreOne, { title })} title={fill(s.restoreOne, { title })} onClick={() => ask('restore', [item.id])}>
                          <I name="refresh" />
                        </button>
                      ) : (
                        <ConversationMenu
                          title={title}
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
                            { label: s.trash, icon: 'trash', onSelect: () => ask('trash', [item.id]) },
                          ]}
                        />
                      )}
                    </div>
                  </article>
                </Fragment>
              );
            })
          )}
        </div>
        <footer className="cl-pagination">
          <span>{result.total ? fill(t.common.pager.range, { from, to, total: result.total }) : t.common.pager.empty}</span>
          <div className="p-flex">
            <label>
              {t.common.pager.perPage}{' '}
              <select aria-label={s.sizeLabel} value={result.size} onChange={(event) => go({ size: Number(event.target.value) })}>
                {LIST_PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="icon-btn" aria-label={s.previousPage} disabled={result.page <= 1} onClick={() => go({ page: result.page - 1 })}>
              <I name="chevronLeft" />
            </button>
            <span className="mono">
              {result.page} / {pages}
            </span>
            <button type="button" className="icon-btn" aria-label={s.nextPage} disabled={result.page >= pages} onClick={() => go({ page: result.page + 1 })}>
              <I name="chevronRight" />
            </button>
          </div>
        </footer>
      </section>
      <p className="cl-note">
        <I name="shield" />
        {s.note}
      </p>

      <OrganizeConfirm
        request={confirm}
        onClose={() => setConfirm(null)}
        onConfirm={async (current) => {
          setConfirm(null);
          await run(current.action, current.ids);
        }}
      />
      <TrashPreview
        conversation={previewing && { id: previewing.id, title: previewing.title || t.conversations.sidebar.untitled }}
        onClose={() => setPreviewing(null)}
        onRestore={async (id) => {
          setPreviewing(null);
          await run('restore', [id]);
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
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} aria-label={label} onChange={(event) => onChange(event.target.value)}>
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
    <div className="cl-empty">
      <I name={filtered ? 'search' : view === 'archived' ? 'archive' : view === 'trash' ? 'trash' : 'chat'} />
      <h2>{title}</h2>
      <p>{body}</p>
      {filtered ? (
        <button type="button" className="btn secondary sm" onClick={onReset}>
          {t.conversations.search.reset}
        </button>
      ) : view === 'all' || view === 'recent' ? (
        <Link href="/talk?new=1" className="btn">
          {e.start}
        </Link>
      ) : (
        <button type="button" className="btn secondary" onClick={onRecent}>
          {e.recent}
        </button>
      )}
    </div>
  );
}
