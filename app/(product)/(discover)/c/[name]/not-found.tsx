import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { serverMessages } from '@/i18n/server';
import { FeedColumns } from '@/components/shell/feed-columns';
import { Icon } from '@/components/ui/icons';
import { NotFoundMark } from '@/components/shell/page-view';

/** `/c/[name]` for a tag nobody has used: one card, and the way to every channel. */
export default async function ChannelNotFound() {
  const { t } = await serverMessages();
  const c = t.posts.channels;
  return (
    <FeedColumns title={t.posts.tabs.channels} back="/?tab=channels">
      <NotFoundMark />
      <div className="px-[18px] py-10">
        <div className="card flex flex-col items-center px-6 py-14 text-center">
          <Icon name="compass" className="size-7 text-[#a3a9bb]" />
          <h2 className="mt-4 text-[16px] font-bold">{c.notFoundTitle}</h2>
          <p className="mt-1 text-[12px] text-muted">{c.notFoundBody}</p>
          <Link href="/?tab=channels" className="btn mt-5">
            {c.all}
          </Link>
        </div>
      </div>
    </FeedColumns>
  );
}
