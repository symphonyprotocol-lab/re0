import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { json } from '@/lib/http/respond';
import { revealCode } from '@/lib/services/admin-redeem';

/** One code in plaintext. A POST, because every reveal is written to the audit log. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json(await revealCode(administrator.id, (await context.params).id));
  } catch (error) {
    return adminFailure(error);
  }
}
