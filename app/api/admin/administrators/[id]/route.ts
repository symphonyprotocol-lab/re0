import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { adminFailure } from '@/lib/http/admin-lists';
import { appBaseUrl } from '@/lib/http/cookies';
import { body, fail, json } from '@/lib/http/respond';
import { disableAdministrator, reissueInvite } from '@/lib/services/admin-administrators';

/** `{ action: 'disable' }` ends the administrator's access; `{ action: 'link' }` issues a fresh enrolment link (and voids the previous one). Owner only, except that an inviter may re-issue their own invitee's link. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const { id } = params;
  const { action } = await body(request);
  try {
    if (action === 'disable') {
      await disableAdministrator(administrator.id, id);
      return json({ disabled: true });
    }
    if (action === 'link') return json({ link: `${appBaseUrl()}/admin/login?invite=${encodeURIComponent(await reissueInvite(administrator.id, id))}` });
    return fail('action', 422);
  } catch (error) {
    return adminFailure(error);
  }
}
