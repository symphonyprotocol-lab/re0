import type { NextRequest } from 'next/server';
import { fail } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { streamBlobRange } from '@/lib/infra/blob';
import { db } from '@/lib/infra/db';
import { knowledgeFile } from '@/lib/services/knowledge';
import { ownedRee } from '@/lib/services/rees';

/**
 * The uploaded file of a document or audio source, owner only, out of the
 * private store. Byte ranges pass through, so the preview's player can seek
 * to a transcript's timestamp without downloading 100 MB first.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string; kid: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, kid } = await context.params;
  const ree = await ownedRee(db(), user.id, id);
  if (!ree) return fail('not_found', 404);
  const file = await knowledgeFile(ree.id, kid);
  if (!file) return fail('not_found', 404);
  const blob = await streamBlobRange(file.pathname, request.headers.get('range'));
  if (!blob) return fail('not_found', 404);
  const headers = new Headers(blob.headers);
  headers.set('cache-control', 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');
  const download = request.nextUrl.searchParams.get('download') === '1';
  headers.set('content-disposition', `${download ? 'attachment' : 'inline'}; filename="file"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  return new Response(blob.body, { status: blob.status, headers });
}
