import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { currentUser } from '@/lib/http/session';
import { getCompetition, slugOf } from '@/lib/services/competitions';

/** The published leaderboard → `{items}`; 404 before the results. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await currentUser();
  const slug = await slugOf(id);
  const page = slug ? await getCompetition(slug, viewer?.id) : null;
  if (!page || page.id !== id || !page.leaderboard) return fail('not_found', 404);
  return json({ items: page.leaderboard });
}
