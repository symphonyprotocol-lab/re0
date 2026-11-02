import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/http/session';

/** The marketing site arrives in step 3; until then the root goes where the visitor belongs. */
export default async function Home() {
  redirect((await currentUser()) ? '/dashboard' : '/login');
}
