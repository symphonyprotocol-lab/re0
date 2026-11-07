import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { Icon } from '@/components/ui/icons';
import { ShareFrame } from '@/components/share/share-frame';

/** `/s/[slug]` for a slug that is unknown, private or taken down: one card and the way to explore. */
export default async function ShareNotFound() {
  const [user, { t }] = await Promise.all([currentUser(), serverMessages()]);
  const p = t.share.page.notFound;
  return (
    <ShareFrame signedIn={Boolean(user)} home={`RE0 ${t.site.nav.home}`} action={user ? { href: '/rees', label: t.site.nav.open } : { href: '/login', label: t.site.nav.signIn }}>
      <main className="mx-auto w-full max-w-[760px] flex-1 px-4 pb-14 sm:px-6">
        <div className="card flex flex-col items-center px-6 py-14 text-center">
          <Icon name="compass" className="size-7 text-[#a3a9bb]" />
          <h1 className="mt-4 text-[16px] font-bold">{p.title}</h1>
          <p className="mt-1 text-[12px] text-muted">{p.body}</p>
          <Link href="/explore" className="btn mt-5">
            {p.back}
          </Link>
        </div>
      </main>
    </ShareFrame>
  );
}
