/**
 * Step 7 acceptance (rebuild-proposal.md 8.4 "视频介绍"): no script without a
 * ready source; a script holds and settles the configured price, stays inside every
 * shot's limit (an over-limit reply is rewritten, not cut) and is refunded
 * when the model cannot fit it; hand edits over a limit are refused; the
 * first export is free, the second uses the configured price, the same picture again is a
 * cache hit -- free and not counted; an export whose tab closed is released
 * by the cron; cancelling releases at once; public pages and cards carry
 * the introduction. Blob is stubbed; the model is the local fake.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, eq } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const blobs = vi.hoisted(() => new Map<string, number>());
const speak = vi.hoisted(() => vi.fn());
vi.mock('@/lib/infra/ai/speech', async (original) => ({
  ...await original<typeof import('@/lib/infra/ai/speech')>(),
  speakDemoLines: speak,
}));
vi.mock('@/lib/infra/blob', () => ({
  blobSize: async (path: string) => blobs.get(path) ?? null,
  deleteBlob: async (path: string) => void blobs.delete(path),
  uploadTicket: async (pathname: string) => ({ pathname, token: 'vercel_blob_client_test' }),
  writeNarration: async (pathname: string, wav: Buffer) => void blobs.set(pathname, wav.length),
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
const { VIDEO_LIMITS, DEFAULT_VIDEO_SCRIPT_CREDITS } = await import('@/lib/constants');
const { saveVideoExportPrice, videoExportPrice, saveVideoScriptPrice, videoScriptPrice } = await import('@/lib/services/video-pricing');
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
  if (ree.isPublic) await rees.setReePublished(userId, ree.id, true);
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

function generateClassic(...[userId, reeId, write, options]: Parameters<typeof video.generateScript>) {
  return video.generateScript(userId, reeId, write, { template: 'editorial', ...options });
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

  it('holds and settles the default price and keeps every shot inside its limit', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    const before = await balanceOf(db(), userId);
    const row = await generateClassic(userId, ree.id);
    expect(row.generated).toBe(true);
    expect(row.revision).toBe(1);
    expect(sceneErrors(row.scenes!)).toEqual([]);
    expect(row.scenes!.sources.titles.length).toBeLessThanOrEqual(VIDEO_LIMITS.sources);
    expect(await balanceOf(db(), userId)).toBe(before - DEFAULT_VIDEO_SCRIPT_CREDITS);
    expect(await entries(userId, ree.id)).toEqual([
      { reason: 'video_script', delta: -DEFAULT_VIDEO_SCRIPT_CREDITS },
      { reason: 'video_script', delta: 0 },
    ]);
    /* Regenerating charges again and makes a new revision; the style stays. */
    await video.saveVideo(userId, ree.id, { template: 'blueprint' }, 1);
    const again = await generateClassic(userId, ree.id, undefined, { template: 'blueprint' });
    expect(again.revision).toBe(3);
    expect(again.template).toBe('blueprint');
    expect(await balanceOf(db(), userId)).toBe(before - 2 * DEFAULT_VIDEO_SCRIPT_CREDITS);
  });

  it('keeps the reserved price during generation and refuses a stale quote before debiting', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    const before = await balanceOf(db(), userId);
    const [admin] = await db().insert(schema.administrator).values({
      name: 'Video pricing test', email: `${uniqueName('video-price')}@example.test`, passwordHash: 'unused', totpSecretCipher: 'unused',
    }).returning({ id: schema.administrator.id });
    const defaults = await videoScriptPrice();
    expect(defaults).toEqual({ credits: 5, revision: 'default' });
    try {
      expect(await code(saveVideoScriptPrice(admin!.id, { credits: 0, revision: defaults.revision }))).toBe('invalid_video_script_credits');
      const first = await saveVideoScriptPrice(admin!.id, { credits: 8, revision: defaults.revision });
      expect(await code(saveVideoScriptPrice(admin!.id, { credits: 9, revision: defaults.revision }))).toBe('pricing_conflict');
      expect((await video.videoStudio(userId, ree.id)).scriptCredits).toBe(8);
      const generated = await generateClassic(userId, ree.id, async (input) => {
        await saveVideoScriptPrice(admin!.id, { credits: 11, revision: first.revision });
        return video.writeScript(input, userId);
      }, { maxCost: 8 });
      expect(generated.generationCost).toBe(8);
      expect(await code(generateClassic(userId, ree.id, undefined, { maxCost: 8 }))).toBe('price_changed');
      expect(await balanceOf(db(), userId)).toBe(before - 8);
      expect(await entries(userId, ree.id)).toEqual([
        { reason: 'video_script', delta: -8 },
        { reason: 'video_script', delta: 0 },
      ]);
    } finally {
      await db().delete(schema.videoPricing);
    }
  });

  it('asks the model to rewrite a field over its limit instead of cutting it', async () => {
    const userId = await owner();
    const ree = await reeOf(userId, { name: uniqueName('LONGSCRIPT').slice(0, 40) });
    const calls = fake.requests.length;
    const row = await generateClassic(userId, ree.id);
    expect(chars(row.scenes!.opening.name)).toBeLessThanOrEqual(VIDEO_LIMITS.name);
    expect(row.scenes!.opening.name).toBe('Refund Helper');
    /* One live answer for shot 3 is not needed here (no example questions); the script and its rewrite are two calls. */
    expect(fake.requests.slice(calls).filter((request) => request.path.endsWith('/chat/completions')).length).toBeGreaterThanOrEqual(2);
  });

  it('refunds the hold when the script cannot be made to fit', async () => {
    const userId = await owner();
    const ree = await reeOf(userId, { name: uniqueName('FAILSCRIPT').slice(0, 40) });
    const before = await balanceOf(db(), userId);
    expect(await code(generateClassic(userId, ree.id))).toBe('script_failed');
    expect(await balanceOf(db(), userId)).toBe(before);
    expect(await entries(userId, ree.id)).toEqual([
      { reason: 'video_script', delta: -DEFAULT_VIDEO_SCRIPT_CREDITS },
      { reason: 'video_refund', delta: DEFAULT_VIDEO_SCRIPT_CREDITS },
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
    await generateClassic(userId, ree.id, async (material) => {
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
    const row = await generateClassic(userId, ree.id);
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

describeWithDb('product demo voiceover', () => {
  it('defaults to a content-specific voiceover demo even when the saved template is Blueprint', async () => {
    const userId = await owner();
    const ree = await reeOf(userId, {
      name: 'DW200 manual', isPublic: false,
      content: 'Hold an employee badge at the DW200 reader. The terminal scans the badge and displays whether access is allowed.',
    });
    expect((await video.videoStudio(userId, ree.id)).video.template).toBe('product-demo');
    const legacy = await generateClassic(userId, ree.id, undefined, { template: 'blueprint' });
    const options = { revision: legacy.revision };
    const before = await balanceOf(db(), userId);
    expect(await code(video.generateScript(userId, ree.id, undefined, options))).toBe('voice_not_configured');
    expect(await balanceOf(db(), userId)).toBe(before);
    expect((await video.videoStudio(userId, ree.id)).props?.template).toBe('blueprint');

    const [admin] = await db().insert(schema.administrator).values({
      name: 'Voice model test', email: `${uniqueName('voice-admin')}@example.test`, passwordHash: 'unused', totpSecretCipher: 'unused',
    }).returning({ id: schema.administrator.id });
    const models = await import('@/lib/services/models');
    const key = 'test-voice-key-not-logged';
    const model = await models.createModelConfig(admin!.id, {
      kind: 'speech', name: 'OpenAI TTS-1', transport: 'gateway',
      model: 'openai/tts-1', apiKey: key,
    });
    expect(model.hasKey).toBe(true);
    expect(JSON.stringify(model)).not.toContain(key);
    await models.activateModelConfig(admin!.id, model.id);
    const take = Buffer.alloc(2 * 24_000 * 2);
    for (let sample = 0; sample < take.length; sample += 2) take.writeInt16LE(1_200, sample);

    try {
      const { demoCredits } = await video.videoStudio(userId, ree.id);
      expect(demoCredits).toBe(DEFAULT_VIDEO_SCRIPT_CREDITS + 54);
      expect(await code(video.generateScript(userId, ree.id, undefined, { ...options, maxCost: demoCredits! - 1 }))).toBe('price_changed');
      expect(await balanceOf(db(), userId)).toBe(before);
      speak.mockResolvedValueOnce(Array.from({ length: 4 }, () => ({ pcm: take, costUsd: '0.00024' })));
      const row = await video.generateScript(userId, ree.id, undefined, options);
      expect(speak.mock.calls.at(-1)?.[0]).toMatchObject({ apiKey: key, model: 'openai/tts-1' });
      expect(row).toMatchObject({ template: 'product-demo', aspect: '16:9', generated: true, generationCost: DEFAULT_VIDEO_SCRIPT_CREDITS + 10 });
      const demo = row.scenes!.demo!;
      expect(demo.visual).toEqual({ layout: 'device', tone: 'teal', subject: 'DW200 badge reader', deviceAction: 'scan' });
      expect(demo.cues).toHaveLength(4);
      expect(demo.cues[0]).toMatchObject({ start: 6, text: 'Need to check who can enter a door?' });
      expect(demo.cues[1]!.start).toBeGreaterThan(demo.cues[0]!.end);
      expect(demo.cues[3]!.end).toBe(348);
      expect(await video.narrationVisibleTo(ree.id, demo.audioId, null)).toBe(false);
      expect(await video.narrationVisibleTo(ree.id, demo.audioId, userId)).toBe(true);
      const { props } = await video.videoStudio(userId, ree.id);
      expect(props?.narrationUrl).toBe(`/media/video-narration/${ree.id}/${demo.audioId}.wav`);
      expect(blobs.has(props!.narrationUrl!.slice('/media/'.length))).toBe(true);
      const started = await video.startExport(userId, ree.id);
      if (started.cached) throw new Error('The first demo export should be new');
      expect(started.props).toMatchObject({ narrationUrl: props!.narrationUrl, aspect: '16:9', scenes: { demo: { visual: demo.visual, cues: demo.cues } } });
      upload(started.upload.pathname);
      expect(await video.completeExport(userId, ree.id, started.exportId)).toMatchObject({ cost: 0 });

      speak.mockRejectedValueOnce(new Error('voice unavailable'));
      expect(await code(video.generateScript(userId, ree.id, undefined, { ...options, revision: row.revision }))).toBe('script_failed');
      expect((await video.videoOf(db(), ree.id))?.scenes?.demo?.audioId).toBe(demo.audioId);
      expect(await balanceOf(db(), userId)).toBe(before - DEFAULT_VIDEO_SCRIPT_CREDITS - 10);

      const refundRee = await reeOf(userId, { isPublic: false });
      speak.mockResolvedValueOnce(Array.from({ length: 4 }, () => ({ pcm: take, costUsd: '0.00024' })));
      const refund = await video.generateScript(userId, refundRee.id);
      expect(refund.scenes?.demo?.visual).toEqual({ layout: 'conversation', tone: 'amber', subject: 'Refund assistant' });

      /* A too-short narration is rewritten from the last draft; one that never fits is refunded with its own code. */
      const demoCalls = () => fake.requests.filter((request) => request.path.endsWith('/chat/completions')).length;
      const terse = await reeOf(userId, { isPublic: false, content: `${POLICY} TERSE NARRATION` });
      let calls = demoCalls();
      speak.mockResolvedValueOnce(Array.from({ length: 4 }, () => ({ pcm: take, costUsd: '0.00024' })));
      const rewritten = await video.generateScript(userId, terse.id);
      expect(demoCalls() - calls).toBe(2);
      expect(rewritten.scenes?.demo?.cues[0]?.text).toBe('Waiting to find out when your refund arrives?');
      const endless = await reeOf(userId, { isPublic: false, content: `${POLICY} ENDLESS NARRATION` });
      const beforeEndless = await balanceOf(db(), userId);
      calls = demoCalls();
      speak.mockClear();
      expect(await code(video.generateScript(userId, endless.id))).toBe('demo_script_unfit');
      expect(demoCalls() - calls).toBe(3);
      expect(speak).not.toHaveBeenCalled();
      expect(await balanceOf(db(), userId)).toBe(beforeEndless);
    } finally {
      await db().delete(schema.modelConfig).where(eq(schema.modelConfig.id, model.id));
      forgetModelCache();
    }
  });
});

describeWithDb('video exports', () => {
  it('first free, second 50 by default, unchanged again a free uncounted cache hit', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    await generateClassic(userId, ree.id);
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

  it('uses the configured export price after each Ree’s first export and preserves confirmed charges', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    const another = await reeOf(userId);
    const script = await generateClassic(userId, ree.id);
    await generateClassic(userId, another.id);
    const [admin] = await db().insert(schema.administrator).values({
      name: 'Export pricing test', email: `${uniqueName('export-price')}@example.test`, passwordHash: 'unused', totpSecretCipher: 'unused',
    }).returning({ id: schema.administrator.id });
    const balance = await balanceOf(db(), userId);
    try {
      expect(await videoExportPrice()).toEqual({ credits: 50, revision: 'default' });
      expect(await code(saveVideoExportPrice(admin!.id, { credits: 0, revision: 'default' }))).toBe('invalid_video_export_credits');
      const configured = await saveVideoExportPrice(admin!.id, { credits: 65, revision: 'default' });
      expect(await code(saveVideoExportPrice(admin!.id, { credits: 80, revision: 'default' }))).toBe('pricing_conflict');
      expect(await video.videoStudio(userId, ree.id)).toMatchObject({ exportCredits: 65, scriptCredits: DEFAULT_VIDEO_SCRIPT_CREDITS });

      for (const item of [ree, another]) {
        const quote = await video.exportQuote(userId, item.id);
        expect(quote).toEqual({ cached: null, cost: 0 });
        const first = await video.startExport(userId, item.id, undefined, quote.cost);
        if (first.cached) throw new Error('unexpected cache hit');
        upload(first.upload.pathname);
        expect((await video.completeExport(userId, item.id, first.exportId)).cost).toBe(0);
      }
      expect(await balanceOf(db(), userId)).toBe(balance);

      await video.saveVideo(userId, ree.id, { accent: '#118866' }, script.revision);
      expect(await video.exportQuote(userId, ree.id)).toEqual({ cached: null, cost: 65 });
      const increased = await saveVideoExportPrice(admin!.id, { credits: 80, revision: configured.revision });
      expect(await code(video.startExport(userId, ree.id, undefined, 65))).toBe('price_changed');
      expect(await balanceOf(db(), userId)).toBe(balance);
      const paid = await video.startExport(userId, ree.id, undefined, 80);
      if (paid.cached) throw new Error('unexpected cache hit');
      expect(paid.cost).toBe(80);
      await saveVideoExportPrice(admin!.id, { credits: 90, revision: increased.revision });
      upload(paid.upload.pathname);
      expect((await video.completeExport(userId, ree.id, paid.exportId)).cost).toBe(80);
      expect(await balanceOf(db(), userId)).toBe(balance - 80);
      expect(await video.exportQuote(userId, ree.id)).toEqual({ cached: `/media/${paid.upload.pathname}`, cost: 0 });
    } finally {
      await db().delete(schema.videoExportPricing);
    }
  });

  it('a cache hit does not use up the free export', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    await generateClassic(userId, ree.id);
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
    await generateClassic(userId, ree.id);
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
    await generateClassic(userId, ree.id);
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
    await generateClassic(userId, ree.id);
    expect(await code(video.startExport(await owner(), ree.id))).toBe('not_found');
    /* An id that is not a uuid is "not found", never a database error. */
    expect(await code(video.videoStudio(userId, 'abc'))).toBe('not_found');
    expect(await code(video.cancelExport(userId, ree.id, 'not-a-uuid'))).toBe('not_found');
    expect(await code(video.completeExport(userId, ree.id, 'not-a-uuid'))).toBe('not_found');
  });
});

describeWithDb('video on public surfaces', () => {
  it('hides exported introductions and share links on unpublish while retaining owner access', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    await generateClassic(userId, ree.id);
    const first = await video.startExport(userId, ree.id);
    if (first.cached) throw new Error('unexpected cache hit');
    upload(first.upload.pathname);
    await video.completeExport(userId, ree.id, first.exportId);
    expect(await video.exportVisibleTo(ree.id, first.exportId, null)).toBe(true);
    await rees.setReePublished(userId, ree.id, false);
    expect(await video.exportVisibleTo(ree.id, first.exportId, null)).toBe(false);
    expect(await video.exportVisibleTo(ree.id, first.exportId, await owner())).toBe(false);
    expect(await video.exportVisibleTo(ree.id, first.exportId, userId)).toBe(true);
    expect((await video.videoStudio(userId, ree.id)).props?.ree.shareUrl).toBeNull();
  });

  it('cards and the public page carry the introduction; a private Ree has no share link', async () => {
    const userId = await owner();
    const shown = await reeOf(userId);
    const bare = await reeOf(userId);
    await generateClassic(userId, shown.id);
    const cards = await reeCards([shown.id, bare.id]);
    expect(cards.find((card) => card.id === shown.id)!.video?.scenes.opening.name).toBe('Refund Helper');
    expect(cards.find((card) => card.id === bare.id)!.video).toBeNull();
    const hidden = await reeOf(userId, { isPublic: false });
    await generateClassic(userId, hidden.id);
    expect((await video.introsFor([hidden.id])).get(hidden.id)!.ree.shareUrl).toBeNull();
  });
});
