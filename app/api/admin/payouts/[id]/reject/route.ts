import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { body, json } from '@/lib/http/respond';
import { decidePayout } from '@/lib/services/payouts';

/** Reject a pending request with `{ note }` (3–300 characters, shown to the user); the hold is released. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    const input = await body(request);
    return json({ payout: await decidePayout(administrator.id, (await context.params).id, 'rejected', input.note) });
  } catch (error) {
    return adminFailure(error);
  }
}
