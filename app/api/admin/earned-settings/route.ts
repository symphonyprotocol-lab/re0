import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { earnedSettings, saveEarnedSettings } from '@/lib/services/earned';

/** Earned conversion and deduction settings (docs/design/earned-credits.md), audited. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  return json({ settings: await earnedSettings() });
}

export async function PUT(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json({ settings: await saveEarnedSettings(administrator.id, await body(request)) });
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'pricing_conflict' ? 409 : 422);
    throw error;
  }
}
