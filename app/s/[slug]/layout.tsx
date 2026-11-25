import { Instrument_Sans } from 'next/font/google';
import type { ReactNode } from 'react';

/**
 * The share page's own face (design A, 2026-11-25): Instrument Sans for its
 * headings, figures and text, Latin only -- Chinese falls through to the
 * site's PingFang / YaHei chain (components/share/share.css `--share-font`).
 * Only `/s/[slug]` loads it; the rest of the site stays on Inter.
 */
const instrument = Instrument_Sans({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-instrument', display: 'swap' });

export default function ShareLayout({ children }: { children: ReactNode }) {
  return <div className={instrument.variable}>{children}</div>;
}
