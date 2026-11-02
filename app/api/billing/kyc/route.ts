import type { NextRequest } from 'next/server';
import { body, json } from '@/lib/http/respond';
import { refusal } from '@/lib/http/payouts';
import { apiUser } from '@/lib/http/session';
import { kycOverview, submitKyc } from '@/lib/services/kyc';

/** The user's identity state and newest record (no image paths). */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json(await kycOverview(user.id));
}

/**
 * Submits identity details, the two uploaded images' pathnames and the tax
 * declaration (8.4 step 6). Refused while a submission waits or once
 * verified, and for official accounts.
 */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    const record = await submitKyc(user.id, await body(request));
    return json({ id: record.id, status: record.status }, 201);
  } catch (error) {
    return refusal(error);
  }
}
