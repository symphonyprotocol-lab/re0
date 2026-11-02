/**
 * Step 7 acceptance (rebuild-proposal.md 8.4 "视频介绍"): no script without a
 * ready source; a script holds and settles 20 credits, stays inside every
 * shot's limit (an over-limit reply is rewritten, not cut) and is refunded
 * when the model cannot fit it; hand edits over a limit are refused; the
 * first export is free, the second costs 50, the same picture again is a
 * cache hit -- free and not counted; an export whose tab closed is released
 * by the cron; cancelling releases at once; public pages and cards carry
 * the introduction. Blob is stubbed; the model is the local fake.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, eq } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const blobs = vi.hoisted(() => new Map<string, number>());
vi.mock('@/lib/infra/blob', () => ({
  blobSize: async (path: string) => blobs.get(path) ?? null,
  deleteBlob: async (path: string) => void blobs.delete(path),
  uploadTicket: async (pathname: string) => ({ pathname, token: 'vercel_blob_client_test' }),
}));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { balanceOf } = await import('@/lib/services/credits');
const knowledge = await import('@/lib/services/knowledge');
const rees = await import('@/lib/services/rees');
const video = await import('@/lib/services/video');
const { reeCards } = await import('@/lib/services/explore');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { parseVideoPatch, sceneErrors, chars } = await import('@/lib/domain/video');
const { VIDEO_LIMITS } = await import('@/lib/constants');
const { forgetModelCache } = await import('@/lib/infra/ai/models');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(() => fake?.close());

const POLICY = 'Refund policy. Refunds are issued to the original payment method within 14 days of the request.';

async function owner() {
  const subject = uniqueName('v');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'zh', '/');
  return userId;
}

async function reeOf(userId: string, options: { name?: string; content?: string | null; isPublic?: boolean } = {}) {
  await rees.saveDraft(userId, { ...newReeDraft(), name: options.name ?? uniqueName('Ree').slice(0, 40), description: 'Answers about refunds.', category: 'business', isPublic: options.isPublic ?? true, step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(userId);
  if (options.content !== null) {
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Refund policy notes', content: options.content ?? POLICY });
    await knowledge.processKnowledge(id);
  }
  return ree;
}

/** The Ree's video entries (its knowledge processing writes entries of its own). */
async function entries(userId: string, reeId: string) {
  const rows = await db()
    .select({ reason: schema.creditEntry.reason, delta: schema.creditEntry.delta })
    .from(schema.creditEntry)
    .where(and(eq(schema.creditEntry.userId, userId), eq(schema.creditEntry.reeId, reeId)))
    .orderBy(schema.creditEntry.createdAt);
  return rows.filter((row) => row.reason.startsWith('video_'));
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return 'accepted';
}

/** The browser's part: render, upload to the ticket's pathname. */
function upload(pathname: string) {
  blobs.set(pathname, 2_400_000);
}

describeWithDb('video script', () => {
  it('is refused without a ready source, and nothing is charged', async () => {
    const userId = await owner();
    const ree = await reeOf(userId, { content: null });
    const before = await balanceOf(db(), userId);
    expect(await code(video.generateScript(userId, ree.id))).toBe('no_ready_source');
    expect(await balanceOf(db(), userId)).toBe(before);
    expect(await entries(userId, ree.id)).toEqual([]);
  });

  it('holds 20 credits, settles them, and keeps every shot inside its limit', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    const before = await balanceOf(db(), userId);
    const row = await video.generateScript(userId, ree.id);
    expect(row.generated).toBe(true);
    expect(row.revision).toBe(1);
    expect(sceneErrors(row.scenes!)).toEqual([]);
    expect(row.scenes!.sources.titles.length).toBeLessThanOrEqual(VIDEO_LIMITS.sources);
    expect(await balanceOf(db(), userId)).toBe(before - 20);
    expect(await entries(userId, ree.id)).toEqual([
      { reason: 'video_script', delta: -20 },
      { reason: 'video_script', delta: 0 },
    ]);
    /* Regenerating charges again and makes a new revision; the style stays. */
    await video.saveVideo(userId, ree.id, { template: 'blueprint' }, 1);
    const again = await video.generateScript(userId, ree.id);
    expect(again.revision).toBe(3);
    expect(again.template).toBe('blueprint');
    expect(await balanceOf(db(), userId)).toBe(before - 40);
  });

  it('asks the model to rewrite a field over its limit instead of cutting it', async () => {
    const userId = await owner();
    const ree = await reeOf(userId, { name: uniqueName('LONGSCRIPT').slice(0, 40) });
    const calls = fake.requests.length;
    const row = await video.generateScript(userId, ree.id);
    expect(chars(row.scenes!.opening.name)).toBeLessThanOrEqual(VIDEO_LIMITS.name);
    expect(row.scenes!.opening.name).toBe('Refund Helper');
    /* One live answer for shot 3 is not needed here (no example questions); the script and its rewrite are two calls. */
    expect(fake.requests.slice(calls).filter((request) => request.path.endsWith('/chat/completions')).length).toBeGreaterThanOrEqual(2);
  });

  it('refunds the hold when the script cannot be made to fit', async () => {
    const userId = await owner();
    const ree = await reeOf(userId, { name: uniqueName('FAILSCRIPT').slice(0, 40) });
    const before = await balanceOf(db(), userId);
    expect(await code(video.generateScript(userId, ree.id))).toBe('script_failed');
    expect(await balanceOf(db(), userId)).toBe(before);
    expect(await entries(userId, ree.id)).toEqual([
      { reason: 'video_script', delta: -20 },
      { reason: 'video_refund', delta: 20 },
    ]);
    expect(await video.videoOf(db(), ree.id)).toBeNull();
  });

  it('uses an answer the owner liked, or asks an example question now, for shot 3', async () => {
    const userId = await owner();
    await rees.saveDraft(userId, { ...newReeDraft(), name: uniqueName('Asked').slice(0, 40), description: 'Refunds.', category: 'business', sampleQuestions: 'When are refunds issued?', step: 4, reached: 4 });
    const { ree } = await rees.createReeFromDraft(userId);
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Refund policy notes', content: POLICY });
    await knowledge.processKnowledge(id);
    const prompts: string[] = [];
    await video.generateScript(userId, ree.id, async (material) => {
      prompts.push(`${material.question} => ${material.answer}`);
      return { opening: { name: 'Refunds', position: 'Policy answers' }, sources: { titles: ['Notes'] }, answer: { question: material.question!, answer: material.answer! }, closing: { cta: 'Ask it' } };
    });
    /* The fake's answer, first sentence only, citation marker gone. */
    expect(prompts).toEqual(['When are refunds issued? => Refunds are issued to the original payment method within 14 days.']);
  });
});

describeWithDb('video edits', () => {
  it('refuses over-limit text, saves within limits, and stops a stale tab', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    const row = await video.generateScript(userId, ree.id);
    const tooLong = parseVideoPatch({ revision: row.revision, scenes: { ...row.scenes, closing: { cta: '这是一句远远超过十六个字的号召文字内容' } } });
    expect('error' in tooLong && tooLong.error).toBe('scene_limits');
    expect('error' in tooLong && tooLong.errors).toEqual([{ field: 'cta', issue: 'too_long', max: 16 }]);
    const parsed = parseVideoPatch({ revision: row.revision, accent: '#AA3355', aspect: '9:16', music: false, scenes: { ...row.scenes, closing: { cta: '现在就问它' } } });
    if ('error' in parsed) throw new Error(parsed.error);
    const saved = await video.saveVideo(userId, ree.id, parsed.patch, parsed.revision);
    expect(saved).toMatchObject({ accentColor: '#aa3355', aspect: '9:16', music: false, revision: row.revision + 1 });
    expect(saved.scenes!.closing.cta).toBe('现在就问它');
    expect(await code(video.saveVideo(userId, ree.id, { music: true }, row.revision))).toBe('stale');
  });

  it('lets the style be saved before a script exists, but not shot text', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    const styled = await video.saveVideo(userId, ree.id, { template: 'spotlight' }, 0);
    expect(styled).toMatchObject({ generated: false, template: 'spotlight', revision: 1 });
    const scenes = { opening: { name: 'A', position: 'B' }, sources: { titles: ['C'] }, answer: { question: 'D', answer: 'E' }, closing: { cta: 'F' } };
    expect(await code(video.saveVideo(userId, ree.id, { scenes }, 1))).toBe('no_script');
  });
});

describeWithDb('video exports', () => {
  it('first free, second 50, unchanged again a free uncounted cache hit', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    await video.generateScript(userId, ree.id);
    const start = await balanceOf(db(), userId);
    expect(await video.exportQuote(userId, ree.id)).toEqual({ cached: null, cost: 0 });

    const first = await video.startExport(userId, ree.id);
    if (first.cached) throw new Error('unexpected cache hit');
    expect(first.cost).toBe(0);
    expect(first.upload.pathname).toBe(`videos/${ree.id}/${first.exportId}.mp4`);
    expect(first.props.ree.shareUrl).toMatch(new RegExp(`/r/${ree.slug}$`));
    expect(await code(video.completeExport(userId, ree.id, first.exportId))).toBe('upload_missing');
    upload(first.upload.pathname);
    expect(await video.exportFinished(ree.id, first.exportId)).toBe(false);
    expect(await video.completeExport(userId, ree.id, first.exportId)).toEqual({ url: `/media/${first.upload.pathname}`, cost: 0 });
    expect(await video.exportFinished(ree.id, first.exportId)).toBe(true);
    expect(await balanceOf(db(), userId)).toBe(start);
    expect((await video.videoOf(db(), ree.id))!.exportsCount).toBe(1);

    /* Same picture: the file, free, no row, no count -- and the quote says so before anything is asked. */
    expect(await video.exportQuote(userId, ree.id)).toEqual({ cached: `/media/${first.upload.pathname}`, cost: 0 });
    const hit = await video.startExport(userId, ree.id);
    expect(hit).toEqual({ cached: true, url: `/media/${first.upload.pathname}`, aspect: '16:9' });
    expect((await video.videoOf(db(), ree.id))!.exportsCount).toBe(1);

    /* A new accent is a new picture: 50 held at the start, settled on completion. */
    const current = (await video.videoOf(db(), ree.id))!;
    await video.saveVideo(userId, ree.id, { accent: '#118866' }, current.revision);
    expect(await video.exportQuote(userId, ree.id)).toEqual({ cached: null, cost: 50 });
    const second = await video.startExport(userId, ree.id);
    if (second.cached) throw new Error('unexpected cache hit');
    expect(second.cost).toBe(50);
    expect(await balanceOf(db(), userId)).toBe(start - 50);
    upload(second.upload.pathname);
    await video.completeExport(userId, ree.id, second.exportId);
    expect(await balanceOf(db(), userId)).toBe(start - 50);
    expect((await video.videoOf(db(), ree.id))!.exportsCount).toBe(2);

    /* And unchanged again: cached, still 2, nothing charged. */
    const again = await video.startExport(userId, ree.id);
    expect(again.cached).toBe(true);
    expect((await video.videoOf(db(), ree.id))!.exportsCount).toBe(2);
    expect(await balanceOf(db(), userId)).toBe(start - 50);

    const ledger = (await entries(userId, ree.id)).filter((entry) => entry.reason !== 'video_script');
    expect(ledger).toEqual([
      { reason: 'video_export', delta: -50 },
      { reason: 'video_export', delta: 0 },
    ]);
    const rows = await db().select({ status: schema.videoExport.status, cost: schema.videoExport.costCredits }).from(schema.videoExport).where(eq(schema.videoExport.reeId, ree.id));
    expect(rows.map((row) => `${row.status}:${row.cost}`).sort()).toEqual(['done:0', 'done:50']);
  });

  it('a cache hit does not use up the free export', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    await video.generateScript(userId, ree.id);
    const first = await video.startExport(userId, ree.id);
    if (first.cached) throw new Error('unexpected cache hit');
    /* Cancelled: released at once, the free one is still there. */
    expect(await video.cancelExport(userId, ree.id, first.exportId)).toBe(true);
    const retry = await video.startExport(userId, ree.id);
    if (retry.cached) throw new Error('unexpected cache hit');
    expect(retry.cost).toBe(0);
  });

  it('releases the hold of an export whose tab was closed, through the cron', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    await video.generateScript(userId, ree.id);
    const free = await video.startExport(userId, ree.id);
    if (free.cached) throw new Error('unexpected cache hit');
    upload(free.upload.pathname);
    await video.completeExport(userId, ree.id, free.exportId);
    const current = (await video.videoOf(db(), ree.id))!;
    await video.saveVideo(userId, ree.id, { template: 'spotlight' }, current.revision);
    const before = await balanceOf(db(), userId);
    const started = new Date(Date.now() - 31 * 60_000);
    const paid = await video.startExport(userId, ree.id, started);
    if (paid.cached) throw new Error('unexpected cache hit');
    expect(await balanceOf(db(), userId)).toBe(before - 50);
    /* The tab closes; nothing completes. The cron gives it back. */
    const swept = await video.abandonExports();
    expect(swept.exports).toBeGreaterThanOrEqual(1);
    expect(await balanceOf(db(), userId)).toBe(before);
    const [row] = await db().select().from(schema.videoExport).where(eq(schema.videoExport.id, paid.exportId));
    expect(row!.status).toBe('abandoned');
    expect((await entries(userId, ree.id)).slice(-1)).toEqual([{ reason: 'video_refund', delta: 50 }]);
    /* Idempotent, and an abandoned export cannot complete afterwards. */
    await video.abandonExports();
    expect(await balanceOf(db(), userId)).toBe(before);
    upload(paid.upload.pathname);
    expect(await code(video.completeExport(userId, ree.id, paid.exportId))).toBe('export_closed');
    /* The late upload is never served, and it is removed. */
    expect(await video.exportFinished(ree.id, paid.exportId)).toBe(false);
    expect(blobs.has(paid.upload.pathname)).toBe(false);
    expect((await video.videoOf(db(), ree.id))!.exportsCount).toBe(1);
  });

  it('starting again abandons the earlier unfinished export, so a reload never holds twice', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    await video.generateScript(userId, ree.id);
    const free = await video.startExport(userId, ree.id);
    if (free.cached) throw new Error('unexpected cache hit');
    upload(free.upload.pathname);
    await video.completeExport(userId, ree.id, free.exportId);
    await video.saveVideo(userId, ree.id, { aspect: '9:16' }, (await video.videoOf(db(), ree.id))!.revision);
    const before = await balanceOf(db(), userId);
    await video.startExport(userId, ree.id);
    await video.startExport(userId, ree.id);
    expect(await balanceOf(db(), userId)).toBe(before - 50);
    const open = await db().select().from(schema.videoExport).where(and(eq(schema.videoExport.reeId, ree.id), eq(schema.videoExport.status, 'started')));
    expect(open).toHaveLength(1);
  });

  it('only the owner can export, and a Ree without a script cannot', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    expect(await code(video.startExport(userId, ree.id))).toBe('no_script');
    await video.generateScript(userId, ree.id);
    expect(await code(video.startExport(await owner(), ree.id))).toBe('not_found');
    /* An id that is not a uuid is "not found", never a database error. */
    expect(await code(video.videoStudio(userId, 'abc'))).toBe('not_found');
    expect(await code(video.cancelExport(userId, ree.id, 'not-a-uuid'))).toBe('not_found');
    expect(await code(video.completeExport(userId, ree.id, 'not-a-uuid'))).toBe('not_found');
  });
});

describeWithDb('video on public surfaces', () => {
  it('cards and the public page carry the introduction; a private Ree has no share link', async () => {
    const userId = await owner();
    const shown = await reeOf(userId);
    const bare = await reeOf(userId);
    await video.generateScript(userId, shown.id);
    const cards = await reeCards([shown.id, bare.id]);
    expect(cards.find((card) => card.id === shown.id)!.video?.scenes.opening.name).toBe('Refund Helper');
    expect(cards.find((card) => card.id === bare.id)!.video).toBeNull();
    const hidden = await reeOf(userId, { isPublic: false });
    await video.generateScript(userId, hidden.id);
    expect((await video.introsFor([hidden.id])).get(hidden.id)!.ree.shareUrl).toBeNull();
  });
});
