import { PageSkeleton } from '@/components/dashboard/page-skeleton';

/**
 * From the list into one asset. A segment's boundary shows when the
 * segment newly mounts, so this answers the row click; the dashboard's own
 * boundary only covers a change of top-level screen, and without this the
 * list stayed on screen, unanswering, until the asset had its data.
 */
export default function AssetLoading() {
  return <PageSkeleton variant="detail" />;
}
