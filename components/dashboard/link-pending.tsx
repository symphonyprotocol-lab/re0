'use client';

import { useLinkStatus } from 'next/link';
import type { ReactNode } from 'react';
import { SpinnerIcon } from '@/components/ui/icons';

/**
 * Inside a `Link`: shows `children` (usually the link's own icon) until the
 * link is clicked, then a spinner in the same place until the page arrives.
 * Next.js reports pending per link, so only the clicked one changes.
 */
export function LinkPending({ children = null, size = 14, className = '' }: { children?: ReactNode; size?: number; className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return <>{children}</>;
  return <SpinnerIcon size={size} className={`shrink-0 motion-safe:animate-spin ${className}`} />;
}
