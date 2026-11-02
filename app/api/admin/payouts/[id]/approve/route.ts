import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { decidePayout } from '@/lib/services/payouts';

/** Approve a pending request (identity verified, not official); the credits stay held. `{ note }` optional. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    const input = await body(request);
    return json({ payout: await decidePayout(administrator.id, (await context.params).id, 'approved', input.note) });
  } catch (error) {
    return adminFailure(error);
  }
}
