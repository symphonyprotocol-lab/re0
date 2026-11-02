'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { dateGroup, searchReturnPath, type DateGroup } from '@/lib/domain/conversation';
import { conversationApi } from '@/lib/client/conversations';
import type { HistoryItem } from '@/lib/services/conversations';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { useToast } from '@/components/ui/toast';
import { I } from '@/components/chat/message-parts';
import { ConversationMenu } from '@/components/conversations/conversation-menu';
import { RenameDialog } from '@/components/conversations/rename-dialog';
import { OrganizeConfirm, type OrganizeRequest } from '@/components/conversations/organize-confirm';

interface HistoryState {
  /** The conversation open right now, so the sidebar can show it even when archived. */
  current: HistoryItem | null;
  setCurrent: (item: HistoryItem | null) => void;
}

const HistoryContext = createContext<HistoryState>({ current: null, setCurrent: () => undefined });

export function HistoryProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<HistoryItem | null>(null);
  const value = useMemo(() => ({ current, setCurrent }), [current]);
  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>;
}

/** A conversation page announces itself to the sidebar while it is open. */
export function useCurrentConversation(item: HistoryItem | null): void {
  const { setCurrent } = useContext(HistoryContext);
  const key = item ? `${item.id}:${item.title}:${item.archived}:${item.pinned}` : '';
  useEffect(() => {
    setCurrent(item);
    return () => setCurrent(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, setCurrent]);
}

/**
 * The sidebar's conversation tools and history (prototype conversations.js
 * `sidebar`): 新建对话 and 搜索对话 (⌘K), then pinned and recent
 * conversations, recent ones grouped by day in UTC+8; the open one is
 * highlighted, and shown on its own when it is archived. ⌘K / Ctrl+K opens
 * the search page from anywhere in the workspace -- back to the search a
 * conversation was opened from, when it was -- with the box focused.
 */
export function SidebarConversations({ history, collapsed, className = 'px-3' }: { history: HistoryItem[]; collapsed: boolean; /** The sidebar's horizontal inset, until the frame pads the whole sidebar (prototype `.sidebar` padding). */ className?: string }) {
  const { t, locale } = useI18n();
  const c = t.conversations.sidebar;
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const { current } = useContext(HistoryContext);
  const [renaming, setRenaming] = useState<HistoryItem | null>(null);
  const [confirm, setConfirm] = useState<(OrganizeRequest & { active: boolean }) | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const currentId = /^\/chats\/([0-9a-f-]{36})/.exec(pathname)?.[1] ?? null;

  /* On `/chats` the box takes focus; from a conversation opened from a search, back to that search (prototype conversations.js `openSearchPage`). */
  const openSearch = () => {
    const box = document.querySelector<HTMLInputElement>('#conversation-search');
    if (box) return box.focus();
    const from = /^\/chats\/[^/]+$/.test(window.location.pathname) ? new URLSearchParams(window.location.search).get('from') : null;
    const back = from ? searchReturnPath(from) : '/chats';
    router.push(`${back}${back.includes('?') ? '&' : '?'}focus=1`);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k' || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      openSearch();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    const active = scroller.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [currentId]);

  const pinned = history.filter((item) => item.pinned);
  const recent = history.filter((item) => !item.pinned);
  const showCurrent = current && current.id === currentId && !history.some((item) => item.id === current.id) ? current : null;
  const now = new Date();

  const act = async (run: () => Promise<unknown>, done?: string) => {
    try {
      await run();
      if (done) toast(done);
      router.refresh();
    } catch {
      toast(t.common.errors.generic);
    }
  };

  const row = (item: HistoryItem) => {
    const title = item.title || c.untitled;
    const active = item.id === currentId;
    return (
      <div key={item.id} className={`chat-history-row${active ? ' active' : ''}`}>
        <Link href={`/chats/${item.id}`} aria-current={active ? 'page' : undefined} aria-label={title} title={title}>
          {item.pinned && <I name="pin" />}
          <span className="chat-history-title">{title}</span>
        </Link>
        <ConversationMenu
          beside
          title={title}
          label={fill(c.more, { title })}
          items={[
            /* `/chats` works out the tab and page that hold it (prototype conversations.js `cl-select-one`). */
            { label: t.conversations.search.selectOne, icon: 'check', onSelect: () => router.push(`/chats?select=${item.id}`) },
            { label: t.conversations.search.rename, icon: 'settings', onSelect: () => setRenaming(item) },
            ...(!item.archived
              ? [
                  {
                    label: item.pinned ? t.conversations.search.unpin : t.conversations.search.pinOne,
                    icon: 'pin' as const,
                    onSelect: () => act(() => conversationApi.update(item.id, { pinned: !item.pinned }), item.pinned ? t.conversations.search.unpinnedToast : t.conversations.search.pinnedToast),
                  },
                ]
              : []),
            {
              label: item.archived ? t.conversations.search.unarchive : t.conversations.search.archiveOne,
              icon: 'archive',
              onSelect: () => setConfirm({ action: item.archived ? 'unarchive' : 'archive', ids: [item.id], titles: [title], active }),
            },
            { label: t.conversations.search.trash, icon: 'trash', onSelect: () => setConfirm({ action: 'trash', ids: [item.id], titles: [title], active }) },
          ]}
        />
      </div>
    );
  };

  let last: DateGroup | null = null;
  return (
    <>
      <div className={`chat-sidebar-tools${collapsed ? ' is-collapsed' : ''} ${className}`} role="group" aria-label={c.tools}>
        {/* `?new=1` drops the draft kept on /talk and focuses its box. */}
        <Tool href="/talk?new=1" icon="plus" label={c.newChat} active={pathname === '/talk'} button />
        <Tool
          href="/chats?focus=1"
          icon="search"
          label={c.search}
          active={pathname === '/chats'}
          kbd="⌘ K"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            openSearch();
          }}
        />
      </div>
      {!collapsed && (
        <div ref={scroller} className={`chat-history-scroll ${className}`} role="region" tabIndex={0} aria-label={c.history}>
          {showCurrent && (
            <>
              <h3>{c.current}</h3>
              {row(showCurrent)}
            </>
          )}
          {pinned.length > 0 && (
            <>
              <h3>
                {c.pinned}
                <span className="chat-history-count">{formatNumber(pinned.length, locale)}</span>
              </h3>
              {pinned.map(row)}
            </>
          )}
          {recent.length > 0 && (
            <h3>
              {c.recent}
              <span className="chat-history-count">{formatNumber(recent.length, locale)}</span>
            </h3>
          )}
          {recent.map((item) => {
            const group = dateGroup(new Date(item.updatedAt), now, false);
            const heading = group !== last ? <h4 className="chat-history-date">{c.groups[group]}</h4> : null;
            last = group;
            return (
              <Fragment key={item.id}>
                {heading}
                {row(item)}
              </Fragment>
            );
          })}
          {!pinned.length && !recent.length && !showCurrent && <p className="chat-history-empty">{c.empty}</p>}
        </div>
      )}
      {collapsed && <div className="flex-1" />}
      <OrganizeConfirm
        request={confirm}
        onClose={() => setConfirm(null)}
        onConfirm={async (request) => {
          const active = confirm?.active ?? false;
          setConfirm(null);
          const [id] = request.ids;
          if (!id) return;
          await act(async () => {
            await conversationApi.update(id, request.action === 'trash' ? { trashed: true } : { archived: request.action === 'archive' });
            if (request.action === 'trash' && active) router.push('/chats');
          }, request.action === 'trash' ? t.conversations.search.trashed : fill(t.conversations.search.changed, { n: 1 }));
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
    </>
  );
}

function Tool({ href, icon, label, active, kbd, onClick, button = false }: { href: string; icon: 'plus' | 'search'; label: string; active: boolean; kbd?: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void; button?: boolean }) {
  return (
    <Link href={href} onClick={onClick} title={label} aria-label={label} aria-current={active ? 'page' : undefined} className={`${button ? 'btn ' : ''}chat-sidebar-tool${active ? ' active' : ''}`}>
      <I name={icon} />
      <span>{label}</span>
      {kbd && <kbd>{kbd}</kbd>}
    </Link>
  );
}
