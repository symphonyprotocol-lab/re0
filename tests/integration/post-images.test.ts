/**
 * Images on posts (lib/domain/post-images.ts, lib/services/post-images.ts):
 * what a publish may name, the rows it keeps, the review reading the images
 * themselves with their description, the description standing in for them
 * in matching, the answers getting the images, private posts and 转为公开,
 * who may see an image, and a generation entry that cannot read images
 * being refused.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import type { AnswerOne, ProcessDeps } from '@/lib/services/posts';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

/* An in-memory Blob store: what the browser uploaded, by pathname. */
const store = vi.hoisted(() => ({ blobs: new Map<string, { bytes: Uint8Array; contentType: string }>() }));
vi.mock('@/lib/infra/blob-access', async (original) => ({
  ...(await original<typeof import('@/lib/infra/blob-access')>()),
  blobInfo: async (pathname: string) => {
    const blob = store.blobs.get(pathname);
    return blob ? { size: blob.bytes.length, contentType: blob.contentType } : null;
  },
}));
vi.mock('@/lib/infra/blob', async (original) => ({
  ...(await original<typeof import('@/lib/infra/blob')>()),
  readBlob: async (pathname: string) => store.blobs.get(pathname)?.bytes ?? null,
}));
/* The gateway catalog, without the network: these two models are tagged. */
vi.mock('@/lib/infra/ai/gateway-generation-pricing', async (original) => ({
  ...(await original<typeof import('@/lib/infra/ai/gateway-generation-pricing')>()),
  gatewayModelVision: async (model: string) => (model === 'catalog/down' ? undefined : model === 'google/gemini-3.5-flash'),
}));

const { createSession } = await import('@/lib/services/auth');
const posts = await import('@/lib/services/posts');
const privatePosts = await import('@/lib/services/private-posts');
const images = await import('@/lib/services/post-images');
const models = await import('@/lib/services/models');
const { addGrant } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { POST_IMAGE_MAX_BYTES } = await import('@/lib/domain/post-images');
const { QUERY_BASE_FEE } = await import('@/lib/constants');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const { newReeDraft } = await import('@/lib/domain/ree');

/* A 1x1 PNG. */
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  await fake?.close();
});

async function user(prefix: string, credits = 200) {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'en', '/');
  if (credits > 0) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

/** One image this user "uploaded": in the store under their prefix. */
function upload(userId: string, contentType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png', bytes = PNG): string {
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[contentType];
  const pathname = `post-images/${userId}/${crypto.randomUUID()}.${extension}`;
  store.blobs.set(pathname, { bytes, contentType });
  return pathname;
}

async function publicRee() {
  const ownerId = await user('img-owner', 1_000);
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Refund desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: 'Refund policy', content: 'Refunds are issued to the original payment method within 14 days of the request.' });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true }).where(eq(schema.ree.id, ree.id));
  return ree.id;
}

/** The real review and description (the fake model), a fixed match, and answers that record what they were given. */
function recording(reeIds: string[]) {
  const seen: { subject: string; images: number }[] = [];
  const matched: string[] = [];
  const answerOne: AnswerOne = async ({ subject, images: given }) => {
    seen.push({ subject, images: given?.length ?? 0 });
    return { state: 'answered', text: 'Within 14 days [1].', citations: [], model: 'stub' };
  };
  const deps: ProcessDeps = {
    match: async ({ question }) => {
      matched.push(question);
      return { answerers: reeIds.map((reeId) => ({ reeId, similarity: 0.8, mentioned: false })), candidates: reeIds.length, skipped: 0, vector: null };
    },
    answerOne,
    aiAnswer: async () => ({ text: 'AI', model: 'stub' }),
  };
  return { deps, seen, matched };
}

describeWithDb('post images', () => {
  it('refuses images that are not the author\'s own uploads, too many, missing or too large', async () => {
    const author = await user('img-author');
    const other = await user('img-other');
    const question = 'What does this receipt say about my refund?';
    expect(await posts.publishPost(author, { question, lang: 'en', images: [upload(other)] })).toEqual({ ok: false, error: 'invalid_images' });
    expect(await posts.publishPost(author, { question, lang: 'en', images: 'post-images/x' })).toEqual({ ok: false, error: 'invalid_images' });
    expect(await posts.publishPost(author, { question, lang: 'en', images: Array.from({ length: 5 }, () => upload(author)) })).toEqual({ ok: false, error: 'too_many_images' });
    const twice = upload(author);
    expect(await posts.publishPost(author, { question, lang: 'en', images: [twice, twice] })).toEqual({ ok: false, error: 'invalid_images' });
    expect(await posts.publishPost(author, { question, lang: 'en', images: [`post-images/${author}/${crypto.randomUUID()}.png`] })).toEqual({ ok: false, error: 'invalid_images' });
    expect(await posts.publishPost(author, { question, lang: 'en', images: [upload(author, 'image/png', new Uint8Array(POST_IMAGE_MAX_BYTES + 1))] })).toEqual({ ok: false, error: 'invalid_images' });
    /* The stored type must match the name: a webp object named .png is refused. */
    const misnamed = `post-images/${author}/${crypto.randomUUID()}.png`;
    store.blobs.set(misnamed, { bytes: PNG, contentType: 'image/webp' });
    expect(await posts.publishPost(author, { question, lang: 'en', images: [misnamed] })).toEqual({ ok: false, error: 'invalid_images' });
    expect(await db().select().from(schema.post).where(eq(schema.post.userId, author))).toHaveLength(0);
  });

  it('reviews a public post with its images, writes their description for matching, and answers with the images', async () => {
    const reeId = await publicRee();
    const author = await user('img-author');
    const paths = [upload(author), upload(author, 'image/jpeg')];
    const made = await posts.publishPost(author, { question: 'Is this refund on time?', lang: 'en', images: paths });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const rows = await db().select().from(schema.postImage).where(eq(schema.postImage.postId, made.id)).orderBy(asc(schema.postImage.position));
    expect(rows.map((row) => [row.position, row.pathname, row.contentType, row.bytes])).toEqual([[0, paths[0], 'image/png', PNG.length], [1, paths[1], 'image/jpeg', PNG.length]]);

    /* The same submit again (same text, same uploads) is the same post; other uploads are another. */
    expect(await posts.publishPost(author, { question: 'Is this refund on time?', lang: 'en', images: paths })).toEqual({ ok: true, id: made.id, duplicate: true });

    const before = fake.requests.length;
    const { deps, seen, matched } = recording([reeId]);
    await posts.processPost(made.id, deps);
    const after = fake.requests.slice(before).filter((request) => request.path.endsWith('/chat/completions'));
    /* The description, then the review: both read both images. */
    const describing = after.find((request) => request.system?.includes('You describe the images attached'));
    const reviewing = after.find((request) => request.system?.includes('You review a question before it is posted publicly'));
    expect(describing?.images).toBe(2);
    expect(reviewing?.images).toBe(2);

    const [row] = await db().select().from(schema.post).where(eq(schema.post.id, made.id));
    expect(row).toMatchObject({ status: 'published', answerState: 'done', answerCount: 1 });
    expect(row!.imageText).toContain('REFUND ISSUED 14 DAYS');
    /* Matching reads the description; the answer reads it and the images themselves. */
    expect(matched[0]).toContain('REFUND ISSUED 14 DAYS');
    expect(seen).toEqual([{ subject: expect.stringContaining('[Images] Image 1: A receipt'), images: 2 }]);

    /* The page shows them where /media serves them. */
    const view = await posts.getPost(made.id);
    expect(view?.images).toEqual(paths.map((pathname) => ({ url: `/media/${pathname}` })));
  });

  it('keeps a post pending when an image cannot be read or described, and refuses it when the review does', async () => {
    const author = await user('img-author');
    const gone = `post-images/${author}/${crypto.randomUUID()}.png`;
    store.blobs.set(gone, { bytes: PNG, contentType: 'image/png' });
    const made = await posts.publishPost(author, { question: 'What is in this picture?', lang: 'en', images: [gone] });
    if (!made.ok) throw new Error(made.error);
    store.blobs.delete(gone);
    expect(await posts.moderatePost(made.id)).toBe('pending');

    const undescribed = await posts.publishPost(author, { question: 'IMAGES UNREADABLE here?', lang: 'en', images: [upload(author)] });
    if (!undescribed.ok) throw new Error(undescribed.error);
    expect(await posts.moderatePost(undescribed.id)).toBe('pending');

    const refused = await posts.publishPost(author, { question: 'UNPUBLISHABLE picture', lang: 'en', images: [upload(author)] });
    if (!refused.ok) throw new Error(refused.error);
    expect(await posts.moderatePost(refused.id)).toBe('rejected');
  });

  it('lets the author always see their images, anyone else only while the post is public and live, administrators any public post', async () => {
    const author = await user('img-author');
    const reader = await user('img-reader');
    const pathname = upload(author);
    const made = await posts.publishPost(author, { question: 'Who may see this image?', lang: 'en', images: [pathname] });
    if (!made.ok) throw new Error(made.error);
    expect(await images.postImageVisibleTo(pathname, author)).toBe(true);
    expect(await images.postImageVisibleTo(pathname, reader)).toBe(false);
    expect(await images.postImageVisibleTo(pathname, null)).toBe(false);
    expect(await images.postImageVisibleTo(pathname, null, true)).toBe(true);
    await db().update(schema.post).set({ status: 'published', publishedAt: new Date() }).where(eq(schema.post.id, made.id));
    expect(await images.postImageVisibleTo(pathname, reader)).toBe(true);
    expect(await images.postImageVisibleTo(pathname, null)).toBe(true);
    /* An upload no post names is nobody's to see. */
    expect(await images.postImageVisibleTo(upload(author), author)).toBe(false);
  });

  it('gives a private post\'s images to its answers, with a description for retrieval, and copies them on 转为公开', async () => {
    const reeId = await publicRee();
    const author = await user('img-private', 500);
    const reader = await user('img-reader');
    const pathname = upload(author, 'image/webp');
    const made = await privatePosts.publishPrivatePost(author, { question: 'Private: is this refund on time?', reeIds: [reeId], fees: { [reeId]: QUERY_BASE_FEE }, lang: 'en', images: [pathname] });
    if (!made.ok) throw new Error(made.error);
    const { deps, seen } = recording([reeId]);
    await privatePosts.processPrivatePost(made.id, deps);
    expect(seen).toEqual([{ subject: expect.stringContaining('REFUND ISSUED 14 DAYS'), images: 1 }]);
    expect(await images.postImageVisibleTo(pathname, author)).toBe(true);
    expect(await images.postImageVisibleTo(pathname, reader)).toBe(false);
    expect(await images.postImageVisibleTo(pathname, null, true)).toBe(false);

    const copy = await privatePosts.convertToPublic(author, made.id);
    if (!copy.ok) throw new Error(copy.error);
    const [copied] = await db().select().from(schema.post).where(eq(schema.post.id, copy.id));
    expect(copied!.imageText).toContain('REFUND ISSUED 14 DAYS');
    expect((await db().select().from(schema.postImage).where(eq(schema.postImage.postId, copy.id))).map((row) => row.pathname)).toEqual([pathname]);
    /* Published after review: the copy shows the image to anyone; the private post's row stays private. */
    await posts.processPost(copy.id, {});
    expect((await db().select().from(schema.post).where(eq(schema.post.id, copy.id)))[0]!.status).toBe('published');
    expect(await images.postImageVisibleTo(pathname, reader)).toBe(true);
  });

  it('refuses to enable or add a generation entry that cannot read images', async () => {
    /* Whatever lists earlier files left: put back afterwards. */
    const chains = await db().select().from(schema.modelChain).where(eq(schema.modelChain.kind, 'generation'));
    const enabled = await db().select({ id: schema.modelConfig.id, enabled: schema.modelConfig.enabled, enabledPlan: schema.modelConfig.enabledPlan }).from(schema.modelConfig).where(eq(schema.modelConfig.kind, 'generation'));
    const [admin] = await db().insert(schema.administrator).values({ email: `${uniqueName('vision')}@example.test`, passwordHash: 'x', totpSecretCipher: 'x', name: 'Vision' }).returning();
    const compatible = (name: string, supportsImages?: boolean) =>
      models.createModelConfig(admin!.id, { name: uniqueName(name), kind: 'generation', transport: 'openai_compatible', baseUrl: fake.baseUrl, model: 'fake-gen-1', apiKey: 'k', ...(supportsImages === undefined ? {} : { supportsImages }) });
    const blind = await compatible('blind');
    expect(blind).toMatchObject({ supportsImages: false, readsImages: false });
    await expect(models.activateModelConfig(admin!.id, blind.id, 'free')).rejects.toMatchObject({ message: 'no_vision' });
    const seeing = await compatible('seeing', true);
    expect(seeing.readsImages).toBe(true);
    await models.activateModelConfig(admin!.id, seeing.id, 'free');
    await expect(models.addToChain(admin!.id, 'generation', 'free', blind.id)).rejects.toMatchObject({ message: 'no_vision' });
    /* An entry in use keeps its mark. */
    await expect(models.updateModelConfig(admin!.id, seeing.id, { name: 'seeing', transport: 'openai_compatible', baseUrl: fake.baseUrl, model: 'fake-gen-1', supportsImages: false })).rejects.toMatchObject({ message: 'locked' });
    /* Gateway entries by the catalog's vision tag; a catalog that cannot say refuses too. */
    const gateway = (model: string) => models.createModelConfig(admin!.id, { name: uniqueName('gw'), kind: 'generation', transport: 'gateway', model, apiKey: 'k' });
    await expect(models.activateModelConfig(admin!.id, (await gateway('deepseek/deepseek-v4-flash')).id, 'plan')).rejects.toMatchObject({ message: 'no_vision' });
    await expect(models.activateModelConfig(admin!.id, (await gateway('catalog/down')).id, 'plan')).rejects.toMatchObject({ message: 'vision_unknown' });
    const vision = await gateway('google/gemini-3.5-flash');
    expect(vision.readsImages).toBe(true);
    await models.activateModelConfig(admin!.id, vision.id, 'plan');
    await db().delete(schema.modelChain).where(eq(schema.modelChain.kind, 'generation'));
    if (chains.length) await db().insert(schema.modelChain).values(chains);
    await db().update(schema.modelConfig).set({ enabled: false, enabledPlan: false }).where(eq(schema.modelConfig.kind, 'generation'));
    for (const row of enabled) if (row.enabled || row.enabledPlan) await db().update(schema.modelConfig).set({ enabled: row.enabled, enabledPlan: row.enabledPlan }).where(eq(schema.modelConfig.id, row.id));
    forgetModelCache();
  });
});
