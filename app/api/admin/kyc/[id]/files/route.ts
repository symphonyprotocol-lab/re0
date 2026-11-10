import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { json } from '@/lib/http/respond';
import { kycFiles } from '@/lib/services/kyc';

/**
 * Signed links to the document photo and the selfie, each good for 60
 * seconds; every link issued writes a `kyc.files.view` audit row. A POST,
 * since it records something. `deleted` once the retention purge ran.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    return json(await kycFiles(administrator.id, params.id));
  } catch (error) {
    return adminFailure(error);
  }
}
