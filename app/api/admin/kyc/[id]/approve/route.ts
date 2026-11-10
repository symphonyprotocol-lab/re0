import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { decideKyc } from '@/lib/services/kyc';

/** Approve the newest pending submission: `{ matched: true }` (the reviewer compared the images), an unexpired document, both images on file; `{ reason }` optional. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    const input = await body(request);
    return json({ record: await decideKyc(administrator.id, params.id, 'verified', input) });
  } catch (error) {
    return adminFailure(error);
  }
}
