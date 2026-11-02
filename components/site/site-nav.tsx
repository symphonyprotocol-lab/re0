'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** The site's page links, current one marked; a second row of their own on a phone (prototype "手机端主导航分两行"). */
export function SiteNav({ links, label, className = '' }: { links: { href: string; label: string }[]; label: string; className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className={`flex items-stretch gap-1 ${className}`}>
      {links.map((link) => {
        const current = link.href === '/' ? pathname === '/' : pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? 'page' : undefined}
            className={`flex flex-none items-center border-b-2 px-3 text-[13px] font-medium whitespace-nowrap ${
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
