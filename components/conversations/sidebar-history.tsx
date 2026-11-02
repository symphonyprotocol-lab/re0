'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { dateGroup, type DateGroup } from '@/lib/domain/conversation';
import { conversationApi } from '@/lib/client/conversations';
import type { HistoryItem } from '@/lib/services/conversations';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { RowMenu } from '@/components/ui/row-menu';
import { useToast } from '@/components/ui/toast';
import { RenameDialog } from '@/components/conversations/rename-dialog';

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
 * the search page from anywhere in the workspace.
 */
export function SidebarConversations({ history, collapsed }: { history: HistoryItem[]; collapsed: boolean }) {
  const { t } = useI18n();
  const c = t.conversations.sidebar;
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const { current } = useContext(HistoryContext);
  const [renaming, setRenaming] = useState<HistoryItem | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const currentId = /^\/chats\/([0-9a-f-]{36})/.exec(pathname)?.[1] ?? null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k' || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      const box = document.querySelector<HTMLInputElement>('#conversation-search');
      if (box) box.focus();
      else router.push('/chats?focus=1');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
      <div key={item.id} className={`group flex items-center rounded-lg ${active ? 'bg-soft text-blue' : 'text-[#3b4361] hover:bg-wash'}`}>
        <Link href={`/chats/${item.id}`} aria-current={active ? 'page' : undefined} title={title} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-3 text-[12px]">
          {item.pinned && <Icon name="pin" className="size-3 flex-none text-muted" />}
          <span className="truncate">{title}</span>
        </Link>
        <RowMenu
          label={fill(c.more, { title })}
          className="!size-7 opacity-60 group-hover:opacity-100 focus:opacity-100"
          items={[
            { label: t.conversations.search.rename, icon: 'settings', onSelect: () => setRenaming(item) },
            ...(!item.archived
              ? [{ label: item.pinned ? t.conversations.search.unpin : t.conversations.search.pinOne, icon: 'pin' as const, onSelect: () => act(() => conversationApi.update(item.id, { pinned: !item.pinned })) }]
              : []),
            {
              label: item.archived ? t.conversations.search.unarchive : t.conversations.search.archiveOne,
              icon: 'archive',
              onSelect: () => act(() => conversationApi.update(item.id, { archived: !item.archived }), fill(t.conversations.search.changed, { n: 1 })),
            },
            {
              label: t.conversations.search.trash,
              icon: 'trash',
              danger: true,
              onSelect: () =>
                act(async () => {
                  await conversationApi.update(item.id, { trashed: true });
                  if (active) router.push('/chats');
                }, t.conversations.search.trashed),
            },
          ]}
        />
      </div>
    );
  };

  let last: DateGroup | null = null;
  return (
    <>
      <div className={`mt-3 flex flex-col gap-1 px-3 ${collapsed ? 'px-2' : ''}`} role="group">
        <Tool href="/talk" icon="plus" label={c.newChat} active={pathname === '/talk'} collapsed={collapsed} />
        <Tool href="/chats" icon="search" label={c.search} active={pathname === '/chats'} collapsed={collapsed} kbd="⌘ K" />
      </div>
      {!collapsed && (
        <div ref={scroller} className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-3" role="region" tabIndex={0} aria-label={c.history}>
          {showCurrent && (
            <>
              <h3 className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">{c.current}</h3>
              {row(showCurrent)}
            </>
          )}
          {pinned.length > 0 && (
            <>
              <h3 className="flex items-center justify-between px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
                {c.pinned}
                <span className="font-mono">{pinned.length}</span>
              </h3>
              {pinned.map(row)}
            </>
          )}
          {recent.length > 0 && (
            <h3 className="flex items-center justify-between px-3 pt-3 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">
              {c.recent}
              <span className="font-mono">{recent.length}</span>
            </h3>
          )}
          {recent.map((item) => {
            const group = dateGroup(new Date(item.updatedAt), now, false);
            const heading = group !== last ? <h4 className="px-3 pt-2 pb-0.5 text-[10px] text-[#a3a9bb]">{c.groups[group]}</h4> : null;
            last = group;
            return (
              <div key={item.id}>
                {heading}
                {row(item)}
              </div>
            );
          })}
          {history.length === 0 && !showCurrent && <p className="px-3 pt-3 text-[11px] text-muted">{c.empty}</p>}
        </div>
      )}
      {collapsed && <div className="flex-1" />}
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

function Tool({ href, icon, label, active, collapsed, kbd }: { href: string; icon: 'plus' | 'search'; label: string; active: boolean; collapsed: boolean; kbd?: string }) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      className={`flex h-9 items-center gap-3 rounded-lg px-3 text-[13px] font-medium ${active ? 'bg-soft text-blue' : 'text-[#3b4361] hover:bg-wash hover:text-ink'} ${collapsed ? 'justify-center px-0' : ''}`}
    >
      <Icon name={icon} className="size-[18px] flex-none" />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && kbd && <kbd className="hidden rounded border border-line bg-white px-1 font-mono text-[9px] text-muted md:inline">{kbd}</kbd>}
      {collapsed && <span className="sr-only">{label}</span>}
    </Link>
  );
}
