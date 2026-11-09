'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

interface NavLink {
  href: string;
  label: string;
  /** Other paths that belong to this item (prototype: checkout marks 价格与购买, a public Ree 发现 Ree). */
  also?: string[];
}

function under(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The site's page links, current one marked; site.css moves them to a second row of three on a phone (prototype navigation.css). */
export function SiteNav({ links, label }: { links: NavLink[]; label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label}>
      {links.map((link) => {
        const current =
          link.href === '/' ? pathname === '/' : [link.href, ...(link.also ?? [])].some((href) => under(pathname, href));
        return (
          <Link key={link.href} href={link.href} aria-current={current ? 'page' : undefined}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

function ReturningSignIn({ label, className }: { label: string; className: string }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const here = pathname + (search ? `?${search}` : '');
  const href = pathname === '/' ? '/login' : `/login?returnTo=${encodeURIComponent(here)}`;
  return (
    <Link href={href} className={className}>
      {label}
    </Link>
  );
}

/** 登录 that comes back to this page, query included (prototype public-dot.js: "登录回跳也保留此上下文"). */
export function SignInLink({ label, className = 'btn-secondary' }: { label: string; className?: string }) {
  return (
    <Suspense
      fallback={
        <Link href="/login" className={className}>
          {label}
        </Link>
      }
    >
      <ReturningSignIn label={label} className={className} />
    </Suspense>
  );
}
