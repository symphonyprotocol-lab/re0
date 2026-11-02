import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { appBaseUrl } from '@/lib/http/cookies';
import { body, fail, json } from '@/lib/http/respond';
import { disableAdministrator, reissueInvite } from '@/lib/services/admin-administrators';

/** `{ action: 'disable' }` ends the administrator's access; `{ action: 'link' }` issues a fresh enrolment link. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const id = (await context.params).id;
  const { action } = await body(request);
  try {
    if (action === 'disable') {
      await disableAdministrator(administrator.id, id);
      return json({ disabled: true });
    }
    if (action === 'link') return json({ link: `${appBaseUrl()}/admin/login?invite=${encodeURIComponent(await reissueInvite(id))}` });
    return fail('action', 422);
  } catch (error) {
    return adminFailure(error);
  }
}
