import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { serverMessages } from '@/i18n/server';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';

/**
 * An unknown console record (`notFound()` from any console page): one card
 * inside the console frame and the way back to the overview (prototype
 * `.card.empty`, as its missing user / source pages).
 */
export default async function ConsoleNotFound() {
  const { t } = await serverMessages();
  const p = t.console.notFound;
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: p.title }]} />
      <section className="card empty">
        <h1>{p.title}</h1>
        <p>{p.body}</p>
        <Link href="/admin/overview" className="btn secondary mt16">
          {p.back}
        </Link>
      </section>
    </ConsolePage>
  );
}
