import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PRIVATE_ROBOTS } from '@/lib/seo';

/** The console and its sign-in: never in search results. The frame is ./(console)/layout.tsx. */
export const metadata: Metadata = { robots: PRIVATE_ROBOTS };

export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
