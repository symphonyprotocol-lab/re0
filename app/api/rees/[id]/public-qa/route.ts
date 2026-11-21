import type { NextRequest } from 'next/server';
import { isUuid } from '@/lib/domain/list';
import { fail, json } from '@/lib/http/respond';
import { currentUser } from '@/lib/http/session';
import { listPublicQa } from '@/lib/services/public-qa';

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
