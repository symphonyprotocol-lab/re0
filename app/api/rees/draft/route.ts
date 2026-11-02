import type { NextRequest } from 'next/server';
import { newReeDraft } from '@/lib/domain/ree';
import { body, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { clearDraft, getDraft, saveDraft } from '@/lib/services/rees';

/** `user.ree_draft`: the wizard saves it on every step change, so setup resumes on any device. */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json({ draft: (await getDraft(user.id)) ?? newReeDraft() });
}

export async function PUT(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json({ draft: await saveDraft(user.id, (await body(request)).draft) });
}

export async function DELETE(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json({ draft: await clearDraft(user.id) });
}
