import Link from 'next/link';
import { serverMessages } from '@/i18n/server';
import { Icon } from '@/components/ui/icons';
import { ConsoleTopbar } from '@/components/admin/console-topbar';

/**
 * An unknown console record (`notFound()` from any console page): one card
 * inside the console frame and the way back to the overview.
 */
export default async function ConsoleNotFound() {
  const { t } = await serverMessages();
  const p = t.console.notFound;
  return (
    <>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: p.title }]} />
      <div className="card flex flex-col items-center px-6 py-14 text-center">
        <Icon name="search" className="size-7 text-[#a3a9bb]" />
        <h1 className="mt-4 text-[16px] font-bold">{p.title}</h1>
        <p className="mt-1 text-[12px] text-muted">{p.body}</p>
        <Link href="/admin/overview" className="btn mt-5">
          {p.back}
        </Link>
      </div>
    </>
  );
}
