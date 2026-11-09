import { redirect } from 'next/navigation';

/** Existing bookmarks now open the combined Ree collection and statistics. */
export default function DashboardPage() {
  redirect('/rees');
}
