import type { NextRequest } from 'next/server';
import { isUuid } from '@/lib/domain/list';
import { REE_BATCH_MAX } from '@/lib/domain/ree';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { setReesVisibility } from '@/lib/services/rees';

/**
 * `{ ids, isPublic }`: "设为公开 / 设为私有" for the Rees selected on `/rees`
 * (prototype owned-rees.js). One transaction; answers what changed, what
 * was already there, what was skipped as taken down, and what is no longer
 * the owner's.
 */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const input = await body(request);
  const raw = input.ids;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > REE_BATCH_MAX || !raw.every(isUuid) || typeof input.isPublic !== 'boolean') {
    return fail('invalid_batch', 422);
  }
  const plan = await setReesVisibility(user.id, [...new Set(raw)], input.isPublic);
  return json(plan);
}
