'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  deleteOwnComment,
  moderateComment,
  moveCommentToQuestions,
  postComment,
  reportComment,
  setCommentsClosed,
  type CreatorModeration,
} from '@/lib/application/comments';
import { refusalCode } from '@/lib/http/refusal-code';
import { requireSession } from '@/lib/http/session';

/**
 * Comment actions (agent-first-proposal.md 6.8): a reader writes, replies,
 * deletes their own and reports; the creator pins, hides, deletes, closes
 * and moves a comment to the pending-questions list. Form posts that land
 * back where they came from -- an asset page or the moderation page, never
 * an address the form could name freely.
 */

function backTo(form: FormData): string {
  const raw = String(form.get('returnTo') ?? '');
  /* Only our own two pages; anything else is the moderation page. */
  if (/^\/assets\/[A-Za-z0-9._~\-/]+$/.test(raw) || raw === '/dashboard/comments') return raw;
  return '/dashboard/comments';
}

function done(target: string, outcome: string): never {
  const separator = target.includes('?') ? '&' : '?';
  redirect(`${target}${separator}comment=${outcome}#comments`);
}

export async function postCommentAction(form: FormData): Promise<void> {
  const target = backTo(form);
  const session = await requireSession(target);
  let outcome: string;
  try {
    const { hidden } = await postComment({
      userId: session.user.id,
      workspaceId: session.workspace.id,
      assetId: String(form.get('assetId') ?? ''),
      body: String(form.get('body') ?? ''),
      parentId: String(form.get('parentId') ?? '') || null,
    });
    outcome = hidden ? 'held' : 'posted';
    revalidatePath(target);
  } catch (error) {
    outcome = refusalCode(error, 'post comment');
  }
  done(target, outcome);
}

export async function deleteOwnCommentAction(form: FormData): Promise<void> {
  const target = backTo(form);
  const session = await requireSession(target);
  let outcome = 'deleted';
  try {
    await deleteOwnComment({ userId: session.user.id, commentId: String(form.get('commentId') ?? '') });
    revalidatePath(target);
  } catch (error) {
    outcome = refusalCode(error, 'delete comment');
  }
  done(target, outcome);
}

export async function reportCommentAction(form: FormData): Promise<void> {
  const target = backTo(form);
  const session = await requireSession(target);
  let outcome = 'reported';
  try {
    await reportComment({
      userId: session.user.id,
      workspaceId: session.workspace.id,
      commentId: String(form.get('commentId') ?? ''),
      reason: String(form.get('reason') ?? ''),
    });
  } catch (error) {
    outcome = refusalCode(error, 'report comment');
  }
  done(target, outcome);
}

const MODERATIONS: readonly CreatorModeration[] = ['pin', 'unpin', 'hide', 'unhide', 'delete'];

export async function moderateCommentAction(form: FormData): Promise<void> {
  const target = backTo(form);
  const session = await requireSession(target);
  const action = String(form.get('action') ?? '');
  let outcome = 'saved';
  try {
    const actor = { workspaceId: session.workspace.id, role: session.workspace.role, commentId: String(form.get('commentId') ?? '') };
    if (action === 'question') {
      await moveCommentToQuestions(actor);
      outcome = 'moved';
    } else if ((MODERATIONS as readonly string[]).includes(action)) {
      await moderateComment({ ...actor, action: action as CreatorModeration });
    } else {
      outcome = 'invalid_request';
    }
    revalidatePath(target);
  } catch (error) {
    outcome = refusalCode(error, 'moderate comment');
  }
  done(target, outcome);
}

export async function setCommentsClosedAction(form: FormData): Promise<void> {
  const target = backTo(form);
  const session = await requireSession(target);
  let outcome = 'saved';
  try {
    await setCommentsClosed({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      assetId: String(form.get('assetId') ?? ''),
      closed: form.get('closed') === 'yes',
    });
    revalidatePath(target);
  } catch (error) {
    outcome = refusalCode(error, 'close comments');
  }
  done(target, outcome);
}
