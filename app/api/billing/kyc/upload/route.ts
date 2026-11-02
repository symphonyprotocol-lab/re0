import type { NextRequest } from 'next/server';
import { body, json } from '@/lib/http/respond';
import { refusal } from '@/lib/http/payouts';
import { apiUser } from '@/lib/http/session';
import { kycUploadTicket } from '@/lib/services/kyc';

/**
 * A Blob token for one identity image: `{ contentType, size }` in, a token
 * scoped to `kyc/<user>/<random>.<ext>`, JPG / PNG / WebP and 10 MB out.
 * The browser uploads straight to private Blob.
 */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    return json(await kycUploadTicket(user.id, await body(request)));
  } catch (error) {
    return refusal(error);
  }
}
