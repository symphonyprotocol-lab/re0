import type { NextRequest } from 'next/server';
import { DOCUMENT_MAX_BYTES } from '@/lib/constants';
import { DOCUMENT_CONTENT_TYPES, documentFormat, validDocument } from '@/lib/domain/knowledge';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { uploadTicket } from '@/lib/infra/blob';

/** A cropped 512×512 avatar is far below this. */
const AVATAR_MAX_BYTES = 1024 * 1024;
const AVATAR_TYPES: Record<string, string> = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' };

/** Keeps a readable name in the pathname without letting it steer the path. */
function safeName(fileName: string): string {
  const cleaned = fileName.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned.slice(-120) || 'file';
}

/**
 * A Blob upload token for one file, scoped by purpose to a pathname under
 * the caller, a content type and a size (rebuild-proposal.md 2.1: documents
 * up to 20 MB). The browser uploads straight to Blob and then submits the
 * pathname; the server checks the object again before using it.
 */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const input = await body(request);
  const id = crypto.randomUUID();

  if (input.purpose === 'document') {
    const fileName = String(input.fileName ?? '');
    const size = Number(input.size ?? 0);
    const format = documentFormat(fileName);
    if (!format || !validDocument(fileName, size)) return fail('invalid_document', 422);
    const contentType = DOCUMENT_CONTENT_TYPES[format][0]!;
    const ticket = await uploadTicket(`knowledge/${user.id}/${id}/${safeName(fileName)}`, {
      contentTypes: [contentType],
      maxBytes: DOCUMENT_MAX_BYTES,
    });
    return json({ ...ticket, contentType });
  }

  if (input.purpose === 'avatar') {
    const contentType = String(input.contentType ?? '');
    const extension = AVATAR_TYPES[contentType];
    const size = Number(input.size ?? 0);
    if (!extension || size <= 0 || size > AVATAR_MAX_BYTES) return fail('invalid_avatar', 422);
    const ticket = await uploadTicket(`avatars/${user.id}/${id}.${extension}`, {
      contentTypes: [contentType],
      maxBytes: AVATAR_MAX_BYTES,
    });
    return json({ ...ticket, contentType, url: `/media/${ticket.pathname}` });
  }

  return fail('invalid_purpose', 422);
}
