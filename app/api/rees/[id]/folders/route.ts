import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { createFolder, FolderError, listFolders } from '@/lib/services/knowledge-library';
import { ownedRee } from '@/lib/services/rees';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const ree = await ownedRee(db(), user.id, (await context.params).id);
  if (!ree) return fail('not_found', 404);
  return json({ items: await listFolders(ree.id) });
}

/** `{ name }`: 1–40 characters, unique in this Ree ignoring case. */
export async function POST(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const ree = await ownedRee(db(), user.id, (await context.params).id);
  if (!ree) return fail('not_found', 404);
  try {
    return json({ folder: await createFolder(ree.id, (await body(request)).name) }, 201);
  } catch (error) {
    if (error instanceof FolderError) return fail(error.code, 422);
    throw error;
  }
}
