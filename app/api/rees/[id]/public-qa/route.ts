import type { NextRequest } from 'next/server';
import { isUuid } from '@/lib/domain/list';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser, currentUser } from '@/lib/http/session';
import { listPublicQa, moderateSnapshot, publishOwnAnswer } from '@/lib/services/public-qa';

type Context = { params: Promise<{ id: string }> };

/** `GET ?before=<id>` → `{items, total, next}`: one page of a public Ree's public Q&A (public-qa.ts). */
export async function GET(request: NextRequest, { params }: Context) {
  const { id } = await params;
  const before = request.nextUrl.searchParams.get('before');
  if (before !== null && !isUuid(before)) return fail('invalid_cursor', 400);
  const viewer = await currentUser();
  const page = await listPublicQa(id, { before, viewerId: viewer?.id });
  return page ? json(page) : fail('not_found', 404);
}

/**
 * `{messageId}`: a signed-in asker publishes the Ree's answer to the first
 * question of one of their conversations. The snapshot is redacted and
 * checked now → `{id, status}` (`published`, `rejected`, or `pending` when
 * the check could not run and the cron will retry). 404 for a message that
 * is not theirs, 409 `already_public`, 422 `not_single_turn` / `no_answer`,
 * 403 `public_qa_closed` when the Ree takes no public answers.
 */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('publicQa', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const { id } = await params;
  const input = await body(request);
  const result = await publishOwnAnswer(user.id, id, String(input.messageId ?? ''), user.lang);
  if (result === 'not_found') return fail('not_found', 404);
  if (result === 'already') return fail('already_public', 409);
  if (result === 'not_single_turn' || result === 'no_answer') return fail(result, 422);
  if (result === 'closed') return fail('public_qa_closed', 403);
  const status = await moderateSnapshot(result.id);
  return json({ id: result.id, status: status === 'gone' ? 'pending' : status }, 201);
}
