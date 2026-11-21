import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { adminSetAiAnswer } from '@/lib/services/ai-answers';

/** `{show}`: takes down an AI general answer that passed review (`false`) or restores one reports or an administrator took down (`true`); 409 `stale` when it is not in that state. In the management log. */
export async function POST(request: NextRequest, context: { params: Promise<{ aiId: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const show = (await body(request)).show === true;
  return (await adminSetAiAnswer(administrator.id, params.aiId, show)) ? json({ ok: true }) : fail('stale', 409);
}
