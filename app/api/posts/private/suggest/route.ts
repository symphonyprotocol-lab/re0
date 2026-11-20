import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { POST_QUESTION_MAX } from '@/lib/domain/post';
import { suggestPrivateRees } from '@/lib/services/private-posts';

/** `GET ?q=` → `{items}`: up to three public Rees for a private question, with what each answer costs the viewer (the composer, debounced). */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('browse', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const q = (request.nextUrl.searchParams.get('q') ?? '').slice(0, POST_QUESTION_MAX);
  return json({ items: await suggestPrivateRees(user.id, q) });
}
