'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import {
  confirmMediaUpload,
  createEditorialAsset,
  importPosts,
  prepareMediaUpload,
  publishEditorial,
  saveEditorialDraft,
  unscheduleEditorial,
} from '@/lib/application/editorial';
import { runOperation } from '@/lib/application/ingestion';
import { refreshQaDocument } from '@/lib/application/questions';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import type { UploadTicket } from '@/lib/infrastructure/objects/store';
import { refusalCode } from '@/lib/http/refusal-code';
import { requireSession } from '@/lib/http/session';
import { eq } from 'drizzle-orm';

/**
 * The editor's actions (agent-first-proposal.md 6.5, 6.6): form posts that
 * land back on the page with a code in the query string, plus the two
 * upload steps the media picker calls. Publishing is a person's click here
 * and nowhere else -- it is not an Agent tool (proposal 5.1). Each action
 * re-resolves the session: a server action is a public endpoint.
 */

function actorOf(session: Awaited<ReturnType<typeof requireSession>>) {
  return { workspaceId: session.workspace.id, role: session.workspace.role, userId: session.user.id };
}

function runAfter(operationId: string | null): void {
  if (!operationId) return;
  after(async () => {
    try {
      await runOperation({ operationId });
    } catch (error) {
      console.error(`editorial build failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  });
}

export async function createEditorialAction(form: FormData): Promise<void> {
  const session = await requireSession('/dashboard/posts');
  const kind = form.get('kind') === 'audio' ? 'audio' : 'post';
  let target: string;
  try {
    const { assetId } = await createEditorialAsset({
      ...actorOf(session),
      kind,
      title: String(form.get('title') ?? ''),
      slug: String(form.get('slug') ?? ''),
      rights: {
        origin: form.get('rightsOrigin') ?? undefined,
        license: form.get('rightsLicense') ?? undefined,
        generation: form.get('rightsGeneration') ?? undefined,
        note: form.get('rightsNote') ?? undefined,
      },
    });
    revalidatePath('/dashboard/posts');
    target = `/dashboard/posts/${assetId}?notice=created`;
  } catch (error) {
    target = `/dashboard/posts?error=${refusalCode(error, 'create post')}`;
  }
  redirect(target);
}

export async function importPostsAction(form: FormData): Promise<void> {
  const session = await requireSession('/dashboard/posts');
  let target: string;
  try {
    const drafts = await importPosts({
      ...actorOf(session),
      url: String(form.get('url') ?? ''),
      channelId: String(form.get('channelId') ?? '') || null,
    });
    revalidatePath('/dashboard/posts');
    target = `/dashboard/posts?notice=imported&count=${drafts.length}`;
  } catch (error) {
    target = `/dashboard/posts?error=${refusalCode(error, 'import posts')}`;
  }
  redirect(target);
}

/** Save, publish now, schedule or unschedule: one form, the button pressed says which. */
export async function saveEditorialAction(form: FormData): Promise<void> {
  const assetId = String(form.get('assetId') ?? '');
  const session = await requireSession(`/dashboard/posts/${assetId}`);
  const intent = String(form.get('intent') ?? 'save');
  const actor = actorOf(session);
  let notice: string;
  try {
    if (intent === 'unschedule') {
      await unscheduleEditorial({ ...actor, assetId });
      notice = 'unscheduled';
    } else {
      await saveEditorialDraft({
        ...actor,
        assetId,
        title: String(form.get('title') ?? ''),
        summary: String(form.get('summary') ?? ''),
        body: String(form.get('body') ?? ''),
        channelId: String(form.get('channelId') ?? '') || null,
        access: String(form.get('access') ?? 'free'),
      });
      notice = 'saved';
      if (intent === 'publish' || intent === 'schedule') {
        const result = await publishEditorial({
          ...actor,
          assetId,
          publishAt: intent === 'schedule' ? String(form.get('publishAt') ?? '') : null,
          schedule: intent === 'schedule',
        });
        runAfter(result.operationId);
        notice = result.scheduledFor ? 'scheduled' : 'published';
      }
    }
    revalidatePath('/dashboard/posts');
    revalidatePath(`/dashboard/posts/${assetId}`);
  } catch (error) {
    notice = refusalCode(error, 'save post');
  }
  redirect(`/dashboard/posts/${assetId}?notice=${notice}`);
}

export async function prepareMediaAction(input: {
  assetId: string;
  kind: 'image' | 'audio';
  name: string;
  size: number;
  contentType: string;
}): Promise<{ ok: true; mediaId: string; ticket: UploadTicket; contentType: string } | { ok: false; error: string }> {
  const session = await requireSession(`/dashboard/posts/${input.assetId}`);
  try {
    const prepared = await prepareMediaUpload({ ...actorOf(session), ...input, kind: input.kind === 'audio' ? 'audio' : 'image' });
    return { ok: true, ...prepared };
  } catch (error) {
    return { ok: false, error: refusalCode(error, 'prepare media') };
  }
}

export async function confirmMediaAction(input: {
  mediaId: string;
  caption?: string;
  durationMs?: number | null;
}): Promise<{ ok: true; mediaId: string } | { ok: false; error: string }> {
  const session = await requireSession('/dashboard/posts');
  try {
    const confirmed = await confirmMediaUpload({ ...actorOf(session), mediaId: input.mediaId, caption: input.caption, durationMs: input.durationMs });
    /* A Q&A's audio note changes its document's path: a new version covers the file (proposal 6.7). */
    const [media] = await db()
      .select({ assetId: schema.assetMedia.assetId, kind: schema.asset.kind })
      .from(schema.assetMedia)
      .innerJoin(schema.asset, eq(schema.asset.id, schema.assetMedia.assetId))
      .where(eq(schema.assetMedia.id, confirmed.mediaId));
    if (media?.kind === 'qa') runAfter(await refreshQaDocument({ ...actorOf(session), assetId: media.assetId }));
    revalidatePath('/dashboard/posts');
    return { ok: true, mediaId: confirmed.mediaId };
  } catch (error) {
    return { ok: false, error: refusalCode(error, 'confirm media') };
  }
}
