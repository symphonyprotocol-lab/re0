import type { NextRequest } from 'next/server';
import { coerceDraft, newReeDraft } from '@/lib/domain/ree';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { inputErrorStatus, KnowledgeInputError } from '@/lib/services/knowledge';
import { checkDraftSource, clearDraft, getDraft, saveDraft } from '@/lib/services/rees';

/** `user.ree_draft`: the wizard saves it on every step change, so setup resumes on any device. */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json({ draft: (await getDraft(user.id)) ?? newReeDraft() });
}

/**
 * Saves the draft. `checkSource: true` (leaving step 3) first checks the
 * first source against GitHub and the domain claims, and refuses with the
 * reason -- `github_not_connected`, `domain_unverified`, ... -- instead of saving.
 */
export async function PUT(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const input = await body(request);
  if (input.checkSource === true) {
    try {
      await checkDraftSource(user.id, coerceDraft(input.draft).source);
    } catch (error) {
      if (error instanceof KnowledgeInputError) return fail(error.code, inputErrorStatus(error.code));
      throw error;
    }
  }
  return json({ draft: await saveDraft(user.id, input.draft) });
}

export async function DELETE(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json({ draft: await clearDraft(user.id) });
}
