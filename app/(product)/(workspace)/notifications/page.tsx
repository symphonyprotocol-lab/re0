import type { Metadata } from 'next';
import { currentUser } from '@/lib/http/session';
import { listNotices } from '@/lib/services/notices';
import { serverMessages } from '@/i18n/server';
import { FeedColumns } from '@/components/shell/feed-columns';
import { NoticesTab } from '@/components/settings/notices-tab';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.common.nav.notifications };
}

/** `/notifications` -- 通知 (v5): the in-app notices, newest first, 20 a page; a settings tab until now (`/settings?tab=notices` redirects here). */
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const [user, { t }, query] = await Promise.all([currentUser(), serverMessages(), searchParams]);
  const list = await listNotices(user!.id, Number(query.page) || 1);
  return (
    <FeedColumns title={t.common.nav.notifications}>
      <div className="px-[18px] pt-4 pb-10">
        <NoticesTab
          items={list.items.map((item) => ({ ...item, readAt: item.readAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString() }))}
          total={list.total}
          page={list.page}
          size={list.size}
          unread={list.unread}
        />
      </div>
    </FeedColumns>
  );
}
