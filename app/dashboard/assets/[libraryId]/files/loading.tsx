import { PageSkeleton } from '@/components/dashboard/page-skeleton';

/** Shown the moment this page is opened from the one above it (app/dashboard/assets/[libraryId]/loading.tsx says why). */
export default function Loading() {
  return <PageSkeleton variant="detail" />;
}
