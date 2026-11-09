/**
 * JSON responses for the API: `{ error: code }` with a status, so the page
 * can show its own localized message for the code.
 */
import { NextResponse } from 'next/server';

export function json<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export function fail(code: string, status = 400, extra: Record<string, unknown> = {}): NextResponse {
  return json({ error: code, ...extra }, status);
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = (await request.json()) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
