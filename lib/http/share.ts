/**
 * The share page's visitor cookie: a random id per browser, so `/s/[slug]`
 * can count visitors without storing an IP or a user agent.
 */
import { randomUUID } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import { cookieOptions } from '@/lib/http/cookies';
import { isUuid } from '@/lib/domain/list';

export const VISITOR_COOKIE = 're0_visitor';
const YEAR = 365 * 24 * 60 * 60 * 1000;

/** The request's visitor id, or a new one (`fresh`) to set on the response. */
export function visitorOf(request: NextRequest): { id: string; fresh: boolean } {
  const current = request.cookies.get(VISITOR_COOKIE)?.value;
  return isUuid(current) ? { id: current, fresh: false } : { id: randomUUID(), fresh: true };
}

export function keepVisitor(response: NextResponse, visitor: { id: string; fresh: boolean }): NextResponse {
  if (visitor.fresh) response.cookies.set(VISITOR_COOKIE, visitor.id, cookieOptions(new Date(Date.now() + YEAR)));
  return response;
}
