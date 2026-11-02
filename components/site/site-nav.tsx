'use client';

import Link from 'next/link';
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

/** The site's page links, current one marked; a second row of three on a phone (prototype "手机端主导航分两行"). */
export function SiteNav({ links, label, className = '' }: { links: NavLink[]; label: string; className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className={`flex items-stretch gap-1 ${className}`}>
      {links.map((link) => {
        const current =
          link.href === '/' ? pathname === '/' : [link.href, ...(link.also ?? [])].some((href) => under(pathname, href));
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? 'page' : undefined}
            className={`flex flex-none items-center justify-center border-b-2 px-3 text-[13px] font-medium whitespace-nowrap ${
              current ? 'border-blue text-blue' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

function ReturningSignIn({ label }: { label: string }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const here = pathname + (search ? `?${search}` : '');
  const href = pathname === '/' ? '/login' : `/login?returnTo=${encodeURIComponent(here)}`;
  return (
    <Link href={href} className="btn-secondary">
      {label}
    </Link>
  );
}

/** 登录 that comes back to this page, query included (prototype public-dot.js: "登录回跳也保留此上下文"). */
export function SignInLink({ label }: { label: string }) {
  return (
    <Suspense
      fallback={
        <Link href="/login" className="btn-secondary">
          {label}
        </Link>
      }
    >
      <ReturningSignIn label={label} />
    </Suspense>
  );
}
