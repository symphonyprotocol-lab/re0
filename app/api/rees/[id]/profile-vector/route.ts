import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { refreshProfile } from '@/lib/services/profile';
import { ownedRee } from '@/lib/services/rees';

export const maxDuration = 120;

/**
 * Rebuilds the Ree's knowledge profile now (rebuild-proposal.md 2.4); the
 * end of every knowledge run and every settings save do the same on their
 * own. A private Ree's profile is removed. Billed to the owner like every
 * profile build (`meteredWork`, docs/audit/credit-import-audit.md P2).
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const ree = await ownedRee(db(), user.id, (await context.params).id);
  if (!ree) return fail('not_found', 404);
  return json({ vectors: await refreshProfile(ree.id) });
}
