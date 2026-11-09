import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { deleteFolder, FolderError, renameFolder } from '@/lib/services/knowledge-library';
import { ownedRee } from '@/lib/services/rees';

type Context = { params: Promise<{ id: string; fid: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, fid } = await context.params;
  const ree = await ownedRee(db(), user.id, id);
  if (!ree) return fail('not_found', 404);
  try {
    return json({ folder: await renameFolder(ree.id, fid, (await body(request)).name) });
  } catch (error) {
    if (error instanceof FolderError) return fail(error.code, error.code === 'not_found' ? 404 : 422);
    throw error;
  }
}

/** Its sources, trash included, move to "未分组". */
export async function DELETE(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, fid } = await context.params;
  const ree = await ownedRee(db(), user.id, id);
  if (!ree) return fail('not_found', 404);
  return (await deleteFolder(ree.id, fid)) ? json({ id: fid }) : fail('not_found', 404);
}
