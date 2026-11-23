import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { WorkspaceFrame } from '@/components/shell/workspace-frame';
import { VisitorShell } from '@/components/shell/visitor-shell';
import { ContentPage } from '@/components/site/content-page';
import { Icon } from '@/components/ui/icons';
import { NotFoundMark } from '@/components/shell/page-view';

/** Any address with no page (v6): in the shell like every page, one card and the way home. */
export default async function NotFound() {
  const [user, { t }] = await Promise.all([currentUser(), serverMessages()]);
  const n = t.common.notFound;
  const page = (
    <ContentPage title={n.title} heading={false}>
      <div className="xp-card flex flex-col items-center px-6 py-14 text-center">
        <NotFoundMark />
        <Icon name="compass" className="size-7 text-[#a3a9bb]" />
        <h1 className="mt-4 text-[16px] font-bold">{n.title}</h1>
        <p className="mt-1 text-[12px] text-muted">{n.body}</p>
        <Link href="/" className="btn btn-sm mt-5">
          {n.back}
        </Link>
      </div>
    </ContentPage>
  );
  return user ? <WorkspaceFrame user={user}>{page}</WorkspaceFrame> : <VisitorShell>{page}</VisitorShell>;
}
