'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { runOperation } from '@/lib/application/ingestion';
import { answerQuestion, dismissQuestion, endorseTwinAnswer } from '@/lib/application/questions';
import { refusalCode } from '@/lib/http/refusal-code';
import { requireSession } from '@/lib/http/session';

/**
 * The pending-questions list's actions (agent-first-proposal.md 6.7):
 * answering publishes a Q&A asset and builds it after the response;
 * 作者确认 binds to the version the twin's answer used.
 */

export async function answerQuestionAction(form: FormData): Promise<void> {
  const session = await requireSession('/dashboard/questions');
  let target: string;
  try {
    const { assetId, operationId } = await answerQuestion({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      userId: session.user.id,
      questionId: String(form.get('questionId') ?? ''),
      answer: String(form.get('answer') ?? ''),
      question: String(form.get('question') ?? ''),
      access: String(form.get('access') ?? 'free'),
    });
    after(async () => {
      try {
        await runOperation({ operationId });
      } catch (error) {
        console.error(`Q&A build failed: ${error instanceof Error ? error.message : 'unknown'}`);
      }
    });
    revalidatePath('/dashboard/questions');
    target = `/dashboard/questions?notice=answered&asset=${assetId}`;
  } catch (error) {
    target = `/dashboard/questions?notice=${refusalCode(error, 'answer question')}`;
  }
  redirect(target);
}

export async function dismissQuestionAction(form: FormData): Promise<void> {
  const session = await requireSession('/dashboard/questions');
  let notice = 'dismissed';
  try {
    await dismissQuestion({ workspaceId: session.workspace.id, role: session.workspace.role, questionId: String(form.get('questionId') ?? '') });
    revalidatePath('/dashboard/questions');
  } catch (error) {
    notice = refusalCode(error, 'dismiss question');
  }
  redirect(`/dashboard/questions?notice=${notice}`);
}

export async function endorseAnswerAction(form: FormData): Promise<void> {
  const session = await requireSession('/dashboard/questions');
  let notice = 'endorsed';
  try {
    await endorseTwinAnswer({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      userId: session.user.id,
      twinAnswerId: String(form.get('twinAnswerId') ?? ''),
      endorse: form.get('endorse') === 'yes',
    });
    revalidatePath('/dashboard/questions');
  } catch (error) {
    notice = refusalCode(error, 'endorse answer');
  }
  redirect(`/dashboard/questions?notice=${notice}#twin`);
}
