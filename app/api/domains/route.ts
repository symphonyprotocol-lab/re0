import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { addDomain, DomainError, listDomains } from '@/lib/services/connections';

export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json({ items: await listDomains(user.id) });
}

/** `{ domain }`: a bare domain (no scheme or path); answers the claim with its challenge. */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    return json({ domain: await addDomain(user.id, (await body(request)).domain) }, 201);
  } catch (error) {
    if (error instanceof DomainError) return fail(error.code, 422);
    throw error;
  }
}
