import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { currentUser } from '@/lib/http/session';
import { listChannels } from '@/lib/services/channels';

/** `GET ?q=&cursor=` → `{items, next}`: one page of the Channel tab (channels with a visible post, busiest first), searched by name; anyone. */
export async function GET(request: NextRequest) {
  const viewer = await currentUser();
  const limited = await rateLimited('browse', { userId: viewer?.id ?? null, headers: request.headers });
  if (limited) return limited;
  const params = request.nextUrl.searchParams;
  return json(await listChannels({ q: params.get('q')?.slice(0, 64), cursor: params.get('cursor') }));
}
