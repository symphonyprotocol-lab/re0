import { redirect } from 'next/navigation';

/** A bare Ree link opens its first tab (prototype: "bare studio routes default to Settings"). */
export default async function ReeIndex({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/rees/${(await params).id}/settings`);
}
