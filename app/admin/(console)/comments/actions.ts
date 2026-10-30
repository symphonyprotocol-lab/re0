'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { resolveCommentReport } from '@/lib/application/comments';
import { AdminChangeRefused } from '@/lib/domain/admin';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';

/** The platform's ruling on a reported comment (agent-first-proposal.md 6.8): take it down, or dismiss the reports. */
export async function resolveCommentReportAction(form: FormData): Promise<void> {
  const session = await requireAdminCapability('libraries');
  let outcome = 'done';
  try {
    await resolveCommentReport({
      actor: { administratorId: session.administratorId, clientAddress: clientAddress(await headers()) },
      commentId: String(form.get('commentId') ?? ''),
      ruling: form.get('ruling') === 'remove' ? 'remove' : 'dismiss',
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/comments');
  } catch (error) {
    outcome = error instanceof AdminChangeRefused ? error.code : 'unavailable';
    if (outcome === 'unavailable') console.error(`comment report failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  redirect(`/admin/comments?notice=${outcome}`);
}
