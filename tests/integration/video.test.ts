/**
 * Step 7 acceptance (rebuild-proposal.md 8.4 "视频介绍"): no script without a
 * ready source or a voice model; a narrated script holds the most it can
 * cost and settles the actual script and voiceover cost, in each video
 * type with its own story; a narration that never fits is refunded; the
 * type stays the one the script was written in; the first export is free,
 * the second uses the configured price, the same picture again is a cache
 * hit -- free and not counted; an export whose tab closed is released by
 * the cron; cancelling releases at once; public pages and cards carry the
 * introduction. Blob and the voice are stubbed; the model is the local fake.
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
const models = await import('@/lib/services/models');
const { reeCards } = await import('@/lib/services/explore');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { parseVideoPatch } = await import('@/lib/domain/video');
const { DEFAULT_VIDEO_SCRIPT_CREDITS } = await import('@/lib/constants');
const { saveVideoExportPrice, videoExportPrice, saveVideoScriptPrice, videoScriptPrice } = await import('@/lib/services/video-pricing');
const { forgetModelCache } = await import('@/lib/infra/ai/models');

/* Four voiced lines at 0.00024 USD each cost 10 credits; the hold covers the most four lines could cost (54). */
const VOICE_CREDITS = 10;
const VOICE_LIMIT = 54;
const VOICE_KEY = 'test-voice-key-not-logged';
const take = Buffer.alloc(2 * 24_000 * 2);
for (let sample = 0; sample < take.length; sample += 2) take.writeInt16LE(1_200, sample);

let fake: FakeOpenAi;
let adminId: string;
let voiceId: string | null = null;

async function enableVoice() {
  const model = await models.createModelConfig(adminId, { kind: 'speech', name: 'OpenAI TTS-1', transport: 'gateway', model: 'openai/tts-1', apiKey: VOICE_KEY });
  await models.activateModelConfig(adminId, model.id);
  voiceId = model.id;
  forgetModelCache();
  return model;
}

async function disableVoice() {
  if (voiceId) await db().delete(schema.modelConfig).where(eq(schema.modelConfig.id, voiceId));
  voiceId = null;
  forgetModelCache();
}

beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
  speak.mockImplementation(async (_voice: unknown, lines: readonly string[]) => lines.map(() => ({ pcm: take, costUsd: '0.00024' })));
  if (!TEST_DATABASE_URL) return;
  const [admin] = await db().insert(schema.administrator).values({
    name: 'Video test', email: `${uniqueName('video-admin')}@example.test`, passwordHash: 'unused', totpSecretCipher: 'unused',
  }).returning({ id: schema.administrator.id });
  adminId = admin!.id;
  await enableVoice();
});
afterAll(async () => {
  if (TEST_DATABASE_URL) await disableVoice();
  await fake?.close();
});

const POLICY = 'Refund policy. Refunds are issued to the original payment method within 14 days of the request.';

async function owner() {
  const subject = uniqueName('v');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'zh', '/');
  return userId;
}

async function reeOf(userId: string, options: { name?: string; content?: string | null; isPublic?: boolean; title?: string } = {}) {
  await rees.saveDraft(userId, { ...newReeDraft(), name: options.name ?? uniqueName('Ree').slice(0, 40), description: 'Answers about refunds.', category: 'business', isPublic: options.isPublic ?? true, step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(userId);
  if (ree.isPublic) await rees.setReePublished(userId, ree.id, true);
  if (options.content !== null) {
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: options.title ?? 'Refund policy notes', content: options.content ?? POLICY });
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

const generate = (...args: Parameters<typeof video.generateScript>) => video.generateScript(...args);
const chatCalls = () => fake.requests.filter((request) => request.path.endsWith('/chat/completions')).length;

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

  it('holds the most a narrated script can cost and settles the script price plus the voiceover', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    const before = await balanceOf(db(), userId);
    expect((await video.videoStudio(userId, ree.id)).demoCredits).toBe(DEFAULT_VIDEO_SCRIPT_CREDITS + VOICE_LIMIT);
    const row = await generate(userId, ree.id);
    expect(row).toMatchObject({ generated: true, revision: 1, template: 'product-demo', aspect: '16:9', generationCost: DEFAULT_VIDEO_SCRIPT_CREDITS + VOICE_CREDITS });
    expect(await balanceOf(db(), userId)).toBe(before - DEFAULT_VIDEO_SCRIPT_CREDITS - VOICE_CREDITS);
    expect(await entries(userId, ree.id)).toEqual([
      { reason: 'video_script', delta: -(DEFAULT_VIDEO_SCRIPT_CREDITS + VOICE_LIMIT) },
      { reason: 'video_script', delta: VOICE_LIMIT - VOICE_CREDITS },
    ]);
    /* Regenerating in another type charges again, makes a new revision and replaces the narration. */
    const first = row.scenes!.demo!.audioId;
    const again = await generate(userId, ree.id, { template: 'user-manual', revision: row.revision });
    expect(again).toMatchObject({ revision: 2, template: 'user-manual' });
    expect(again.scenes!.demo).toMatchObject({ kind: 'user-manual' });
    expect(blobs.has(`video-narration/${ree.id}/${first}.wav`)).toBe(false);
    expect(await balanceOf(db(), userId)).toBe(before - 2 * (DEFAULT_VIDEO_SCRIPT_CREDITS + VOICE_CREDITS));
  });

  it('writes each video type with its own scenes and keeps the poster text', async () => {
    const userId = await owner();
    const manual = await generate(userId, (await reeOf(userId, { isPublic: false })).id, { template: 'user-manual' });
    expect(manual.scenes!.demo).toMatchObject({
      kind: 'user-manual', subject: 'DW200 terminal', steps: ['Set up', 'Add a card', 'Stay safe'],
      setup: ['Mount the wall bracket', 'Connect the twelve volt supply', 'Wait for the green light'],
      operation: { title: 'Add an access card' }, caution: { title: 'Keep the reader dry' },
    });
    expect(manual.scenes!.demo!.cues.map((cue) => cue.text)).toEqual([
      'Here is how to get your DW200 terminal running.', 'Mount the bracket and connect the power supply first.',
      'Then open Settings and add an access card.', 'Keep the reader dry to avoid failed scans.',
    ]);
    const course = await generate(userId, (await reeOf(userId, { isPublic: false })).id, { template: 'course-intro' });
    expect(course.scenes!.demo).toMatchObject({
      kind: 'course-intro', course: 'Refund operations 101', badges: ['3 modules', 'Self-paced'], audience: ['Support agents', 'Team leads'],
      modules: ['Refund basics', 'Original payment methods', 'Fourteen-day timing'], cta: 'Start the course',
    });
    const article = await generate(userId, (await reeOf(userId, { isPublic: false })).id, { template: 'article-summary' });
    expect(article.scenes!.demo).toMatchObject({
      kind: 'article-summary', source: 'Refund policy notes', evidence: { figure: '14 days' }, further: ['Store credit rules'],
      points: ['Refunds go to the original method', 'The window is fourteen days', 'Store credit is never forced'],
    });
    expect(article.scenes!.opening.position).toBe('Refunds should be…');
    expect(article.scenes!.sources.titles).toEqual(['Refund policy notes']);
    const { props } = await video.videoStudio(userId, article.reeId);
    expect(props).toMatchObject({ template: 'article-summary', narrationUrl: `/media/video-narration/${article.reeId}/${article.scenes!.demo!.audioId}.wav` });
  });

  it('keeps the reserved price during generation and refuses a stale quote before debiting', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    const before = await balanceOf(db(), userId);
    const defaults = await videoScriptPrice();
    expect(defaults).toEqual({ credits: 5, revision: 'default' });
    try {
      expect(await code(saveVideoScriptPrice(adminId, { credits: 0, revision: defaults.revision }))).toBe('invalid_video_script_credits');
      const first = await saveVideoScriptPrice(adminId, { credits: 8, revision: defaults.revision });
      expect(await code(saveVideoScriptPrice(adminId, { credits: 9, revision: defaults.revision }))).toBe('pricing_conflict');
      expect((await video.videoStudio(userId, ree.id))).toMatchObject({ scriptCredits: 8, demoCredits: 8 + VOICE_LIMIT });
      /* The price changes while the voice is being generated: the reserved one is charged. */
      speak.mockImplementationOnce(async (_voice: unknown, lines: readonly string[]) => {
        await saveVideoScriptPrice(adminId, { credits: 11, revision: first.revision });
        return lines.map(() => ({ pcm: take, costUsd: '0.00024' }));
      });
      const generated = await generate(userId, ree.id, { maxCost: 8 + VOICE_LIMIT });
      expect(generated.generationCost).toBe(8 + VOICE_CREDITS);
      expect(await code(generate(userId, ree.id, { maxCost: 8 + VOICE_LIMIT }))).toBe('price_changed');
      expect(await balanceOf(db(), userId)).toBe(before - 8 - VOICE_CREDITS);
      expect(await entries(userId, ree.id)).toEqual([
        { reason: 'video_script', delta: -(8 + VOICE_LIMIT) },
        { reason: 'video_script', delta: VOICE_LIMIT - VOICE_CREDITS },
      ]);
    } finally {
      await db().delete(schema.videoPricing);
    }
  });

  it('suggests the video type from the Ree’s knowledge before it has a video', async () => {
    const userId = await owner();
    const manual = await reeOf(userId, { name: 'DW200 manual', isPublic: false });
    expect(await video.videoStudio(userId, manual.id)).toMatchObject({ recommended: 'user-manual', video: { template: 'user-manual', generated: false } });
    const course = await reeOf(userId, { isPublic: false, title: 'Week 1 lesson: refunds' });
    expect(await video.videoStudio(userId, course.id)).toMatchObject({ recommended: 'course-intro', video: { template: 'course-intro' } });
    const plain = await reeOf(userId, { isPublic: false });
    expect((await video.videoStudio(userId, plain.id)).recommended).toBe('product-demo');
    /* Once there is a video, its own type is shown; the suggestion is only a badge. */
    await video.saveVideo(userId, manual.id, { template: 'article-summary' }, 0);
    expect(await video.videoStudio(userId, manual.id)).toMatchObject({ recommended: 'user-manual', video: { template: 'article-summary' } });
  });
});

describeWithDb('video edits', () => {
  it('saves the style, keeps the script’s type, and stops a stale tab', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    const row = await generate(userId, ree.id);
    const parsed = parseVideoPatch({ revision: row.revision, accent: '#AA3355', aspect: '9:16', music: false });
    if ('error' in parsed) throw new Error(parsed.error);
    const saved = await video.saveVideo(userId, ree.id, parsed.patch, parsed.revision);
    /* The narrated videos are landscape only. */
    expect(saved).toMatchObject({ accentColor: '#aa3355', aspect: '16:9', music: false, revision: row.revision + 1, scenes: row.scenes });
    expect(await code(video.saveVideo(userId, ree.id, { template: 'course-intro' }, saved.revision))).toBe('no_script');
    expect((await video.videoStudio(userId, ree.id)).props?.template).toBe('product-demo');
    expect(await code(video.saveVideo(userId, ree.id, { music: true }, row.revision))).toBe('stale');
  });

  it('lets the style be saved before a script exists', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    const styled = await video.saveVideo(userId, ree.id, { template: 'article-summary' }, 0);
    expect(styled).toMatchObject({ generated: false, template: 'article-summary', revision: 1 });
    expect((await video.videoStudio(userId, ree.id)).props).toBeNull();
    const row = await generate(userId, ree.id, { revision: 1 });
    expect(row).toMatchObject({ template: 'article-summary', scenes: { demo: { kind: 'article-summary' } } });
  });
});

describeWithDb('product demo voiceover', () => {
  it('needs a configured voice, picks a layout from the sources and rewrites a narration that does not fit', async () => {
    const userId = await owner();
    const ree = await reeOf(userId, {
      name: 'DW200 badge reader', isPublic: false,
      content: 'Hold an employee badge at the DW200 reader. The terminal scans the badge and displays whether access is allowed.',
    });
    const before = await balanceOf(db(), userId);
    await disableVoice();
    try {
      expect((await video.videoStudio(userId, ree.id)).demoCredits).toBeNull();
      expect(await code(video.generateScript(userId, ree.id))).toBe('voice_not_configured');
      expect(await balanceOf(db(), userId)).toBe(before);
    } finally {
      const model = await enableVoice();
      expect(model.hasKey).toBe(true);
      expect(JSON.stringify(model)).not.toContain(VOICE_KEY);
    }

    const { demoCredits } = await video.videoStudio(userId, ree.id);
    expect(await code(video.generateScript(userId, ree.id, { maxCost: demoCredits! - 1 }))).toBe('price_changed');
    expect(await balanceOf(db(), userId)).toBe(before);
    const row = await video.generateScript(userId, ree.id, { template: 'product-demo' });
    expect(speak.mock.calls.at(-1)?.[0]).toMatchObject({ apiKey: VOICE_KEY, model: 'openai/tts-1' });
    const demo = row.scenes!.demo!;
    if (demo.kind) throw new Error('expected a product demo');
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
    expect(await code(video.generateScript(userId, ree.id, { revision: row.revision }))).toBe('script_failed');
    expect((await video.videoOf(db(), ree.id))?.scenes?.demo?.audioId).toBe(demo.audioId);
    expect(await balanceOf(db(), userId)).toBe(before - DEFAULT_VIDEO_SCRIPT_CREDITS - VOICE_CREDITS);

    const refundRee = await reeOf(userId, { isPublic: false });
    const refund = await video.generateScript(userId, refundRee.id);
    expect(refund.scenes?.demo).toMatchObject({ visual: { layout: 'conversation', tone: 'amber', subject: 'Refund assistant' } });

    /* A too-short narration is rewritten from the last draft; one that never fits is refunded with its own code. */
    const terse = await reeOf(userId, { isPublic: false, content: `${POLICY} TERSE NARRATION` });
    let calls = chatCalls();
    const rewritten = await video.generateScript(userId, terse.id);
    expect(chatCalls() - calls).toBe(2);
    expect(rewritten.scenes?.demo?.cues[0]?.text).toBe('Waiting to find out when your refund arrives?');
    const endless = await reeOf(userId, { isPublic: false, content: `${POLICY} ENDLESS NARRATION` });
    const beforeEndless = await balanceOf(db(), userId);
    calls = chatCalls();
    speak.mockClear();
    expect(await code(video.generateScript(userId, endless.id))).toBe('demo_script_unfit');
    expect(chatCalls() - calls).toBe(3);
    expect(speak).not.toHaveBeenCalled();
    expect(await balanceOf(db(), userId)).toBe(beforeEndless);
    expect(await entries(userId, endless.id)).toEqual([
      { reason: 'video_script', delta: -(DEFAULT_VIDEO_SCRIPT_CREDITS + VOICE_LIMIT) },
      { reason: 'video_refund', delta: DEFAULT_VIDEO_SCRIPT_CREDITS + VOICE_LIMIT },
    ]);
    expect(await video.videoOf(db(), endless.id)).toBeNull();
  });
});

describeWithDb('video exports', () => {
  it('first free, second 50 by default, unchanged again a free uncounted cache hit', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    await generate(userId, ree.id);
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
    const script = await generate(userId, ree.id);
    await generate(userId, another.id);
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

  it('a new source, a new price or publishing leaves the export current and cached (review C4)', async () => {
    const userId = await owner();
    const ree = await reeOf(userId, { isPublic: false });
    await generate(userId, ree.id);
    const first = await video.startExport(userId, ree.id);
    if (first.cached) throw new Error('unexpected cache hit');
    upload(first.upload.pathname);
    await video.completeExport(userId, ree.id, first.exportId);

    /* Nothing the frames draw: another source, a higher query fee, publishing (a share link). */
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'More notes', content: `${POLICY} Exchanges are free.` });
    await knowledge.processKnowledge(id);
    await db().update(schema.ree).set({ queryFee: 40, isPublic: true }).where(eq(schema.ree.id, ree.id));
    await rees.setReePublished(userId, ree.id, true);
    expect(await video.exportQuote(userId, ree.id)).toEqual({ cached: `/media/${first.upload.pathname}`, cost: 0 });
    expect((await video.videoStudio(userId, ree.id)).lastExport).toMatchObject({ current: true });
    expect((await video.startExport(userId, ree.id)).cached).toBe(true);
  });

  it('an export stored under the old whole-props identity still matches while nothing changed (review C4)', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    await generate(userId, ree.id);
    const studio = await video.videoStudio(userId, ree.id);
    const pathname = `videos/${ree.id}/legacy.mp4`;
    await db().insert(schema.videoExport).values({
      reeId: ree.id, userId, contentVersion: video.legacyContentVersion(studio.props!), template: studio.video.template, aspect: studio.video.aspect,
      costCredits: 0, status: 'done', blobUrl: pathname, finishedAt: new Date(),
    });
    expect(video.contentVersion(studio.props!)).not.toBe(video.legacyContentVersion(studio.props!));
    expect(await video.exportQuote(userId, ree.id)).toEqual({ cached: `/media/${pathname}`, cost: 0 });
    expect((await video.videoStudio(userId, ree.id)).lastExport).toMatchObject({ current: true });
  });

  it('a cache hit does not use up the free export', async () => {
    const userId = await owner();
    const ree = await reeOf(userId);
    await generate(userId, ree.id);
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
    await generate(userId, ree.id);
    const free = await video.startExport(userId, ree.id);
    if (free.cached) throw new Error('unexpected cache hit');
    upload(free.upload.pathname);
    await video.completeExport(userId, ree.id, free.exportId);
    const current = (await video.videoOf(db(), ree.id))!;
    await video.saveVideo(userId, ree.id, { accent: '#aa3355' }, current.revision);
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
    await generate(userId, ree.id);
    const free = await video.startExport(userId, ree.id);
    if (free.cached) throw new Error('unexpected cache hit');
    upload(free.upload.pathname);
    await video.completeExport(userId, ree.id, free.exportId);
    await video.saveVideo(userId, ree.id, { accent: '#aa3355' }, (await video.videoOf(db(), ree.id))!.revision);
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
    await generate(userId, ree.id);
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
    await generate(userId, ree.id);
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
    await generate(userId, shown.id);
    const cards = await reeCards([shown.id, bare.id]);
    expect(cards.find((card) => card.id === shown.id)!.video?.scenes.demo?.headline).toBe('Find your refund window');
    expect(cards.find((card) => card.id === bare.id)!.video).toBeNull();
    const hidden = await reeOf(userId, { isPublic: false });
    await generate(userId, hidden.id);
    expect((await video.introsFor([hidden.id])).get(hidden.id)!.ree.shareUrl).toBeNull();
  });
});
