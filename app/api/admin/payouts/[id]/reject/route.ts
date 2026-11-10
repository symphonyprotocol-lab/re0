import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { decidePayout } from '@/lib/services/payouts';

/** Reject a pending request with `{ note }` (3–300 characters, shown to the user); the hold is released. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  try {
    const input = await body(request);
    return json({ payout: await decidePayout(administrator.id, params.id, 'rejected', input.note) });
  } catch (error) {
    return adminFailure(error);
  }
}
