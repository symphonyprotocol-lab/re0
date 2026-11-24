import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser, currentUser } from '@/lib/http/session';
import { createDraft, listCompetitions } from '@/lib/services/competitions';

/** `GET ?tab=active|published&cursor=` → `{items, next}`: open and running competitions, or results; anyone (docs/design/competitions.md 13.1). */
export async function GET(request: NextRequest) {
  const viewer = await currentUser();
  const limited = await rateLimited('browse', { userId: viewer?.id ?? null, headers: request.headers });
  if (limited) return limited;
  const params = request.nextUrl.searchParams;
  return json(await listCompetitions(params.get('tab') === 'published' ? 'published' : 'active', { cursor: params.get('cursor') }));
}

/** 建草稿 → 201 `{id, slug}`; 400 with `{error, field}` for a bad field; 409 `channel_taken`; 403 for an account that may not host yet (Q1); 429 past the day's drafts. */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const result = await createDraft(user.id, await body(request));
  if (result.ok) return json({ id: result.id, slug: result.slug }, 201);
  if (result.error === 'channel_taken') return fail(result.error, 409, { field: 'channel' });
  if (result.error === 'host_too_new' || result.error === 'host_needs_ree') return fail(result.error, 403);
  if (result.error === 'daily_limit') return fail(result.error, 429);
  return fail(result.error, 400, result.field ? { field: result.field } : {});
}
