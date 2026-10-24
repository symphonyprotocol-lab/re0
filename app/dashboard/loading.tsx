import { PageSkeleton } from '@/components/dashboard/page-skeleton';

/** Every top-level dashboard screen swaps through this while it loads (components/dashboard/page-skeleton.tsx). */
export default function DashboardLoading() {
  return <PageSkeleton variant="overview" />;
}
