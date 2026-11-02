import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { requestReverification } from '@/lib/services/kyc';

/** "要求重新验证" on the user's newest record (verified or rejected): `{ reason }`, 3–300 characters, sent to the user. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    const input = await body(request);
    return json({ record: await requestReverification(administrator.id, (await context.params).id, input.reason) });
  } catch (error) {
    return adminFailure(error);
  }
}
