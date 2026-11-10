/**
 * The console's route parameters are row ids, all UUIDs. A malformed one
 * would reach Postgres as an invalid `uuid` and surface as a 500; it is a
 * 404 here instead, before any query runs.
 */
import type { NextResponse } from 'next/server';
import { fail } from '@/lib/http/respond';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every parameter a UUID, or the 404 to answer. */
export async function adminParams<T extends Record<string, string>>(params: Promise<T>): Promise<T | NextResponse> {
  const values = await params;
  return Object.values(values).every((value) => UUID.test(value)) ? values : fail('not_found', 404);
}
