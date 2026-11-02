import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireAdministrator } from '@/lib/http/admin';
import { serverMessages } from '@/i18n/server';
import { Icon } from '@/components/ui/icons';

/** The console frame: its own session (checked here against the database), its own fixed bar. */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const administrator = await requireAdministrator();
  const { t } = await serverMessages();
  return (
    <div className="min-h-dvh bg-[#f7f8fc]">
      <header className="fixed inset-x-0 top-0 z-20 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1240px] items-center gap-4 px-4 md:px-8">
          <span className="flex items-center gap-2 font-extrabold">
            <span className="inline-flex size-7 items-center justify-center rounded-lg bg-ink text-white">
              <Icon name="shield" className="size-4" />
            </span>
            <span className="hidden sm:inline">
              {t.common.brand} · {t.admin.console}
            </span>
          </span>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
            <Link href="/admin/models" className="rounded-lg bg-soft px-3 py-1.5 text-[13px] font-semibold text-blue" aria-current="page">
              {t.admin.nav.models}
            </Link>
          </nav>
          <span className="hidden truncate text-[12px] text-muted md:inline">{administrator.email}</span>
          <form action="/api/admin/auth/logout" method="post">
            <button type="submit" className="btn-ghost">
              <Icon name="logout" className="size-3.5" />
              <span className="hidden sm:inline">{t.admin.signOut}</span>
            </button>
          </form>
        </div>
      </header>
      <div className="h-16" aria-hidden="true" />
      {children}
    </div>
  );
}
