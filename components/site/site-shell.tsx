import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { BrandMark, BrandName } from '@/components/ui/brand-mark';
import './site.css';

/**
 * The RE0 wordmark linking home, as the login page shows it. The public
 * site's own header and footer frame is gone (v6): 价格, 了解 RE0, the legal
 * pages and checkout are in the shell (components/site/content-page.tsx,
 * which carries the old footer's small print).
 */
export function Wordmark({ label }: { label: string }) {
  return (
    <Link href="/" className="wordmark" aria-label={label}>
      <BrandMark />
      <BrandName />
    </Link>
  );
}
