import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { applyForVerification, verificationOverview, VerificationRefused } from '@/lib/services/roles';

/** The threshold's figures, what blocks an application, and the history (2.7). */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json(await verificationOverview(user.id));
}

/** Applies for the verified role; the threshold is checked again on the server, whatever the page showed. */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const input = await body(request);
  try {
    return json({ request: await applyForVerification(user.id, { statement: input.statement, links: input.links }) }, 201);
  } catch (error) {
    if (error instanceof VerificationRefused) return fail(error.code, ['statement', 'links'].includes(error.code) ? 422 : 409);
    /* The one-pending-per-user index, should two submissions race past the lock. */
    const cause = (error as { cause?: { code?: string } } | null)?.cause;
    if (cause?.code === '23505') return fail('pending', 409);
    throw error;
  }
}
