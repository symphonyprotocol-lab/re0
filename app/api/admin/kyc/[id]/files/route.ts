import type { NextRequest } from 'next/server';
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
  try {
    return json(await kycFiles(administrator.id, (await context.params).id));
  } catch (error) {
    return adminFailure(error);
  }
}
