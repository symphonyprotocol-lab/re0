import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { json } from '@/lib/http/respond';
import { adminRevokeApiKey } from '@/lib/services/api-keys';

/** The console's forced revoke of a user's API key, audited as `user.api_key.revoke`. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string; keyId: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const { id, keyId } = await context.params;
  try {
    await adminRevokeApiKey(administrator.id, id, keyId);
    return json({ id: keyId });
  } catch (error) {
    return adminFailure(error);
  }
}
