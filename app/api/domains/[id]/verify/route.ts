import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { DomainError, verifyDomain } from '@/lib/services/connections';

/** Runs the DNS TXT and well-known checks (`method` picks which goes first); either one passing verifies. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('domainVerify', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const { id } = await context.params;
  const method = (await body(request)).method === 'well_known' ? 'well_known' : 'dns_txt';
  try {
    const result = await verifyDomain(user.id, id, method);
    return json(result, result.outcome === 'verified' ? 200 : 422);
  } catch (error) {
    if (error instanceof DomainError) return fail(error.code, 404);
    throw error;
  }
}
