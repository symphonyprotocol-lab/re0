import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { Icon } from '@/components/ui/icons';

/**
 * `/r/[slug]` for a slug that is unknown, private or taken down (prototype
 * app.js `notFound`): one card and the way back to explore, inside the
 * (discover) layout -- the site frame for visitors, the workspace once signed in.
 */
export default async function PublicReeNotFound() {
  const [user, { t }] = await Promise.all([currentUser(), serverMessages()]);
  const p = t.discover.public.notFound;
  return (
    <>
      {user && <Topbar crumbs={[{ label: t.discover.explore.title, href: '/explore' }]} />}
      <main className={`mx-auto w-full max-w-[1120px] px-4 pb-16 sm:px-6 ${user ? 'pt-6 md:px-8' : 'pt-10'}`}>
        <div className="card flex flex-col items-center px-6 py-14 text-center">
          <Icon name="compass" className="size-7 text-[#a3a9bb]" />
          <h1 className="mt-4 text-[16px] font-bold">{p.title}</h1>
          <p className="mt-1 text-[12px] text-muted">{p.body}</p>
          <Link href="/explore" className="btn mt-5">
            {p.back}
          </Link>
        </div>
      </main>
    </>
  );
}
