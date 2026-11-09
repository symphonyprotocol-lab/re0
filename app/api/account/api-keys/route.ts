import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { ApiKeyError, createApiKey, listApiKeys } from '@/lib/services/api-keys';

/** The signed-in user's API keys for the MCP server, newest first, with each one's usage. */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json({ items: await listApiKeys(user.id) });
}

/** `{name, expiresInDays?}` → `{key, secret}`; the secret is in this response only. */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    const created = await createApiKey(user.id, await body(request));
    return json(created, 201);
  } catch (error) {
    if (error instanceof ApiKeyError) return fail(error.code, 422);
    throw error;
  }
}
