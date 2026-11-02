import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { appBaseUrl } from '@/lib/http/cookies';
import { body, json } from '@/lib/http/respond';
import { inviteAdministrator, listAdministrators } from '@/lib/services/admin-administrators';

export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  return json({ items: await listAdministrators(), self: administrator.id });
}

/** `{ name, email }`: adds an administrator and answers the one-time enrolment link to hand over. */
export async function POST(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    const { id, token } = await inviteAdministrator(administrator.id, await body(request));
    return json({ id, link: `${appBaseUrl()}/admin/login?invite=${encodeURIComponent(token)}` }, 201);
  } catch (error) {
    return adminFailure(error);
  }
}
