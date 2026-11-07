import type { NextRequest } from 'next/server';
import { AUDIO_MAX_BYTES, DOCUMENT_MAX_BYTES, REE_COVER_MAX_BYTES, REE_IMAGE_EXTENSIONS } from '@/lib/constants';
import { AUDIO_CONTENT_TYPES, audioFormat, DOCUMENT_CONTENT_TYPES, documentFormat, validAudio, validDocument } from '@/lib/domain/knowledge';
import { isUuid } from '@/lib/domain/list';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { uploadTicket } from '@/lib/infra/blob';
import { db } from '@/lib/infra/db';
import { ownedRee } from '@/lib/services/rees';

/** A cropped 512×512 avatar is far below this. */
const AVATAR_MAX_BYTES = 1024 * 1024;

/** Keeps a readable name in the pathname without letting it steer the path. */
function safeName(fileName: string): string {
  const cleaned = fileName.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned.slice(-120) || 'file';
}

/**
 * A Blob upload token for one file, scoped by purpose to a pathname under
 * the caller, a content type and a size (rebuild-proposal.md 2.1: documents
 * up to 20 MB, audio up to 100 MB). The browser uploads straight to Blob and then submits the
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

  if (input.purpose === 'audio') {
    const fileName = String(input.fileName ?? '');
    const size = Number(input.size ?? 0);
    const format = audioFormat(fileName);
    if (!format || !validAudio(fileName, size)) return fail('invalid_audio', 422);
    const contentType = AUDIO_CONTENT_TYPES[format];
    const ticket = await uploadTicket(`knowledge/${user.id}/${id}/${safeName(fileName)}`, {
      contentTypes: [contentType],
      maxBytes: AUDIO_MAX_BYTES,
      /* A 100 MB upload on a slow line takes a while. */
      ttlSeconds: 60 * 60,
    });
    return json({ ...ticket, contentType });
  }

  if (input.purpose === 'avatar' || input.purpose === 'ree-cover') {
    const isCover = input.purpose === 'ree-cover';
    const contentType = String(input.contentType ?? '');
    const extension = Object.hasOwn(REE_IMAGE_EXTENSIONS, contentType) && REE_IMAGE_EXTENSIONS[contentType as keyof typeof REE_IMAGE_EXTENSIONS];
    const size = Number(input.size ?? 0);
    const maxBytes = isCover ? REE_COVER_MAX_BYTES : AVATAR_MAX_BYTES;
    if (!extension || !Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
      return fail(isCover ? 'invalid_cover' : 'invalid_avatar', 422);
    }
    let directory = `avatars/${user.id}`;
    if (isCover) {
      if (!isUuid(input.reeId) || !(await ownedRee(db(), user.id, input.reeId))) return fail('not_found', 404);
      directory = `ree-covers/${input.reeId.toLowerCase()}`;
    }
    const ticket = await uploadTicket(`${directory}/${id}.${extension}`, {
      contentTypes: [contentType],
      maxBytes,
    });
    return json({ ...ticket, contentType, url: `/media/${ticket.pathname}` });
  }

  return fail('invalid_purpose', 422);
}
