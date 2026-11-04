/**
 * Acceptance (8.4 step 2), managing knowledge:
 *   - folders: 1–40 characters, unique per Ree ignoring case; deleting one
 *     sends its sources (trash included) back to 未分组;
 *   - batch move / pause / resume / trash / restore over a cross-page
 *     selection, refused whole when the selection is stale;
 *   - a paused source stops answering, its old citations still open;
 *   - the trash is purged after 30 days with its passages, idempotently;
 *   - reprocessing charges again; a failure refunds in full;
 *   - a name with 「失败」 fails only outside production builds.
 * The prototype's knowledge.js assertions, restated against the database.
 */
import { WELCOME_CREDITS } from '@/lib/constants';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { asc, eq, inArray } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const blobs = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/lib/infra/blob', () => ({
  blobSize: async (path: string) => blobs.get(path)?.length ?? null,
  readBlob: async (path: string) => blobs.get(path) ?? null,
  deleteBlob: async (path: string) => void blobs.delete(path),
}));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { balanceOf } = await import('@/lib/services/credits');
const knowledge = await import('@/lib/services/knowledge');
const library = await import('@/lib/services/knowledge-library');
const rees = await import('@/lib/services/rees');
const chat = await import('@/lib/services/chat');
const { answer } = await import('@/lib/services/answer');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(() => fake?.close());

async function userWithRee() {
  const subject = uniqueName('kl');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'L', avatarUrl: null }, 'zh', '/');
  await rees.saveDraft(userId, { ...newReeDraft(), name: 'Library', category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(userId);
  return { userId, ree };
}

async function readyText(userId: string, ree: { id: string }, title: string, content: string, folderId: string | null = null) {
  const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title, content, folderId });
  await knowledge.processKnowledge(id);
  return id;
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return 'accepted';
}

const listQuery = { q: '', status: 'all' as const, kind: 'all', sort: 'new', size: 20, page: 1 };

describeWithDb('folders', () => {
  it('creates, renames and deletes folders; names are unique per Ree ignoring case', async () => {
    const { userId, ree } = await userWithRee();
    const docs = await library.createFolder(ree.id, '  Product   docs ');
    expect(docs.name).toBe('Product docs');
    expect(await refusal(library.createFolder(ree.id, 'PRODUCT DOCS'))).toBe('folder_exists');
    expect(await refusal(library.createFolder(ree.id, 'x'.repeat(41)))).toBe('invalid_folder_name');
    expect(await refusal(library.createFolder(ree.id, '   '))).toBe('invalid_folder_name');
    const research = await library.createFolder(ree.id, 'Research');
    expect(await refusal(library.renameFolder(ree.id, research.id, 'product docs'))).toBe('folder_exists');
    expect((await library.renameFolder(ree.id, research.id, 'User research')).name).toBe('User research');

    /* A different Ree may reuse the name. */
    const other = await userWithRee();
    expect((await library.createFolder(other.ree.id, 'Product docs')).name).toBe('Product docs');

    const inFolder = await readyText(userId, ree, 'Pricing', 'Plans cost ten dollars a month.', docs.id);
    const trashed = await readyText(userId, ree, 'Old pricing', 'Plans used to cost eight dollars.', docs.id);
    await library.runBatch(userId, ree.id, { action: 'trash', ids: [trashed] });
    let listed = await knowledge.listKnowledge(ree.id, { ...listQuery, folder: docs.id });
    expect(listed.items.map((item) => item.id)).toEqual([inFolder]);
    expect(listed.folders.find((folder) => folder.id === docs.id)?.count).toBe(1);
    expect(listed.counts.trash).toBe(1);

    expect(await library.deleteFolder(ree.id, docs.id)).toBe(true);
    const rows = await db().select({ id: schema.knowledge.id, folderId: schema.knowledge.folderId, enabled: schema.knowledge.enabled, status: schema.knowledge.status }).from(schema.knowledge).where(inArray(schema.knowledge.id, [inFolder, trashed]));
    expect(rows.every((row) => row.folderId === null && row.enabled && row.status === 'ready')).toBe(true);
    /* An unknown folder in the URL falls back to all. */
    listed = await knowledge.listKnowledge(ree.id, { ...listQuery, folder: docs.id });
    expect(listed.folder).toBe('all');
    expect(listed.folderCounts).toEqual({ all: 1, unfiled: 1 });
  });

  it('refuses a folder of another Ree when adding or moving', async () => {
    const { userId, ree } = await userWithRee();
    const other = await userWithRee();
    const foreign = await library.createFolder(other.ree.id, 'Theirs');
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'T', content: 'Body text.', folderId: foreign.id }))).toBe('invalid_folder');
    const id = await readyText(userId, ree, 'T', 'Body text.');
    expect(await refusal(library.runBatch(userId, ree.id, { action: 'move', ids: [id], folderId: foreign.id }))).toBe('invalid_folder');
  });
});

describeWithDb('batch actions', () => {
  it('moves, pauses, resumes, trashes and restores a cross-page selection', async () => {
    const { userId, ree } = await userWithRee();
    const ids: string[] = [];
    for (let n = 0; n < 23; n += 1) ids.push(await readyText(userId, ree, `Note ${String(n).padStart(2, '0')}`, `Note number ${n} about the warehouse.`));
    /* "选择全部 N 个筛选结果": every match, beyond the first page of 20. */
    const all = await knowledge.matchingIds(ree.id, { ...listQuery, q: 'warehouse', sort: 'title' });
    expect(all).toHaveLength(23);
    expect(all[0]).toBe(ids[0]);
    /* The same selection with what the dialogs list and price, in one query. */
    const items = await knowledge.matchingItems(ree.id, { ...listQuery, q: 'warehouse', sort: 'title' });
    expect(items.map((item) => item.id)).toEqual(all);
    expect(items[0]).toMatchObject({ title: 'Note 00', kind: 'text', status: 'ready', enabled: true, chars: 'Note number 0 about the warehouse.'.length });

    const moved = await library.runBatch(userId, ree.id, { action: 'move', ids: all, folderId: null, newFolderName: 'Warehouse' });
    expect(moved).toMatchObject({ changed: 23, folder: { name: 'Warehouse' } });
    const again = await library.runBatch(userId, ree.id, { action: 'move', ids: all.slice(0, 3), folderId: moved.folder!.id });
    expect(again.changed).toBe(0);

    expect((await library.runBatch(userId, ree.id, { action: 'pause', ids: all.slice(0, 5) })).changed).toBe(5);
    let listed = await knowledge.listKnowledge(ree.id, { ...listQuery, status: 'paused' });
    expect(listed.total).toBe(5);
    expect(listed.counts).toMatchObject({ all: 23, ready: 23, paused: 5 });
    expect((await library.runBatch(userId, ree.id, { action: 'resume', ids: all.slice(0, 2) })).changed).toBe(2);

    await library.runBatch(userId, ree.id, { action: 'trash', ids: all.slice(20) });
    listed = await knowledge.listKnowledge(ree.id, { ...listQuery, size: 20, page: 2 });
    expect(listed.total).toBe(20);
    expect(listed.page).toBe(1);
    const trash = await knowledge.listKnowledge(ree.id, { ...listQuery, trash: true });
    expect(trash.items.map((item) => item.id).sort()).toEqual(all.slice(20).sort());
    expect(trash.items[0]!.deletedAt).not.toBeNull();

    /* A stale selection -- one row already in the trash -- refuses the whole batch. */
    expect(await refusal(library.runBatch(userId, ree.id, { action: 'pause', ids: all.slice(19, 21) }))).toBe('not_found');
    await library.runBatch(userId, ree.id, { action: 'restore', ids: all.slice(20) });
    expect((await knowledge.listKnowledge(ree.id, listQuery)).total).toBe(23);

    const detail = await knowledge.knowledgeDetail(ree.id, all[0]!);
    expect(detail!.activity.map((entry) => entry.code).slice(-3)).toEqual(['moved', 'paused', 'enabled']);
  });

  it('renames up to 200 characters, keeping the original name', async () => {
    const { userId, ree } = await userWithRee();
    const id = await readyText(userId, ree, 'draft.md', 'Some text.');
    expect(await library.renameKnowledge(ree.id, id, '  Final   notes ')).toBe('Final notes');
    expect(await refusal(library.renameKnowledge(ree.id, id, 'x'.repeat(201)))).toBe('invalid_title');
    expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ title: 'Final notes', originalTitle: 'draft.md' });
  });

  it('will not trash a source that is still processing', async () => {
    const { userId, ree } = await userWithRee();
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Pending', content: 'Waiting to be processed.' });
    expect(await refusal(library.runBatch(userId, ree.id, { action: 'trash', ids: [id] }))).toBe('busy');
  });
});

describeWithDb('answering from the library', () => {
  it('stops answering from a paused source, and its old citations still open', async () => {
    const { userId, ree } = await userWithRee();
    const id = await readyText(userId, ree, 'Refund policy', 'Refunds are issued to the original payment method within 14 days.');
    const conversation = await chat.testConversation(userId, ree.id);
    await (await answer({ userId, lang: 'zh', conversation, targets: [ree], question: 'When are refunds issued to the original payment method?' })).text();
    const [cited] = (await chat.messagesOf(conversation.id)).filter((message) => message.role === 'ree');
    expect(cited!.citations[0]).toMatchObject({ knowledgeId: id, title: 'Refund policy' });

    await library.runBatch(userId, ree.id, { action: 'pause', ids: [id] });
    expect((await chat.retrieve(ree.id, 'When are refunds issued to the original payment method?')).passages).toHaveLength(0);
    expect(await knowledge.readiness(ree.id)).toEqual({ ready: 0, processing: 0 });
    /* The snapshot is still there, and the source still opens for its owner. */
    const [still] = (await chat.messagesOf(conversation.id)).filter((message) => message.role === 'ree');
    expect(still!.citations[0]!.excerpt).toContain('14 days');
    expect((await knowledge.knowledgeDetail(ree.id, id))?.enabled).toBe(false);

    await library.runBatch(userId, ree.id, { action: 'resume', ids: [id] });
    expect((await chat.retrieve(ree.id, 'When are refunds issued to the original payment method?')).passages.length).toBeGreaterThan(0);
    await library.runBatch(userId, ree.id, { action: 'trash', ids: [id] });
    expect((await chat.retrieve(ree.id, 'When are refunds issued to the original payment method?')).passages).toHaveLength(0);
  });
});

describeWithDb('trash purge', () => {
  it('purges knowledge 30 days after it was trashed, with its passages and files, once', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/p/notes.md`;
    blobs.set(path, new TextEncoder().encode('# Notes\n\nThe office opens at nine.'));
    const doc = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'notes.md' });
    await knowledge.processKnowledge(doc);
    const recent = await readyText(userId, ree, 'Recent', 'Recently trashed text.');
    const kept = await readyText(userId, ree, 'Kept', 'Never trashed.');
    await library.runBatch(userId, ree.id, { action: 'trash', ids: [doc, recent] });
    /* Turn the clock back on one of them: trashed 31 days ago. */
    await db().update(schema.knowledge).set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(schema.knowledge.id, doc));
    expect((await db().select().from(schema.chunk).where(eq(schema.chunk.knowledgeId, doc))).length).toBeGreaterThan(0);

    const first = await library.purgeTrash();
    expect(first.purged).toBeGreaterThanOrEqual(1);
    expect(await knowledge.knowledgeDetail(ree.id, doc)).toBeNull();
    expect(await db().select().from(schema.chunk).where(eq(schema.chunk.knowledgeId, doc))).toHaveLength(0);
    expect(blobs.has(path)).toBe(false);
    expect(await knowledge.knowledgeDetail(ree.id, recent)).not.toBeNull();
    expect(await knowledge.knowledgeDetail(ree.id, kept)).not.toBeNull();

    /* Idempotent; and an injected clock 30 days on takes the other one. */
    expect((await library.purgeTrash()).purged).toBe(0);
    await library.purgeTrash(new Date(Date.now() + 30 * 86_400_000 + 60_000));
    expect(await knowledge.knowledgeDetail(ree.id, recent)).toBeNull();
    expect(await knowledge.knowledgeDetail(ree.id, kept)).not.toBeNull();
  });

  it('keeps an uploaded file another source still uses', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/shared/notes.md`;
    blobs.set(path, new TextEncoder().encode('# Notes\n\nThe office opens at nine.'));
    /* The same upload submitted twice. */
    const gone = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'notes.md' });
    const live = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'notes.md' });
    await knowledge.processMany([gone, live]);
    await library.runBatch(userId, ree.id, { action: 'trash', ids: [gone] });
    await db().update(schema.knowledge).set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(schema.knowledge.id, gone));

    const result = await library.purgeTrash();
    expect(await knowledge.knowledgeDetail(ree.id, gone)).toBeNull();
    expect(blobs.has(path)).toBe(true);
    expect(result.files).toBe(0);
    expect(await knowledge.knowledgeFile(ree.id, live)).toMatchObject({ pathname: path });
  });
});

describeWithDb('charges', () => {
  it('reprocessing charges again; a batch reprocess reserves each source', async () => {
    const { userId, ree } = await userWithRee();
    const a = await readyText(userId, ree, 'A', 'x'.repeat(2500));
    const b = await readyText(userId, ree, 'B', 'y'.repeat(1200));
    const before = await balanceOf(db(), userId);
    await library.runBatch(userId, ree.id, { action: 'reprocess', ids: [a, b] });
    expect(await balanceOf(db(), userId)).toBe(before - 2);
    expect(await refusal(library.runBatch(userId, ree.id, { action: 'reprocess', ids: [a] }))).toBe('busy');
    await knowledge.processMany([a, b]);
    expect(await balanceOf(db(), userId)).toBe(before - 2);
    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, a)).orderBy(asc(schema.creditEntry.createdAt));
    expect(entries.map((entry) => [entry.reason, entry.delta])).toEqual([
      ['knowledge_hold', -1],
      ['knowledge_settle', 0],
      ['knowledge_hold', -1],
      ['knowledge_settle', 0],
    ]);
  });

  it('refuses a reprocess the balance cannot cover, whole', async () => {
    const { userId, ree } = await userWithRee();
    const ids = [await readyText(userId, ree, 'A', 'Short.'), await readyText(userId, ree, 'B', 'Short too.')];
    await db().update(schema.creditGrant).set({ remaining: 1 }).where(eq(schema.creditGrant.userId, userId));
    expect(await refusal(library.runBatch(userId, ree.id, { action: 'reprocess', ids }))).toBe('InsufficientCredits: needs 1 credits, 0 available');
    const rows = await db().select({ status: schema.knowledge.status }).from(schema.knowledge).where(inArray(schema.knowledge.id, ids));
    expect(rows.every((row) => row.status === 'ready')).toBe(true);
  });

  it('a name with 「失败」 fails and refunds in full in test environments, and is processed in production', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/f/季度报告-失败.md`;
    blobs.set(path, new TextEncoder().encode('# Report\n\nRevenue grew four percent.'));
    const failing = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: '季度报告-失败.md' });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 1);
    await knowledge.processKnowledge(failing);
    expect(await knowledge.knowledgeDetail(ree.id, failing)).toMatchObject({ status: 'failed', error: 'simulated' });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS);
    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, failing)).orderBy(asc(schema.creditEntry.createdAt));
    expect(entries.map((entry) => [entry.reason, entry.delta])).toEqual([
      ['knowledge_hold', -1],
      ['knowledge_refund', 1],
    ]);

    /* A production build has no switch: the same file is processed normally. */
    const environment = process.env as Record<string, string | undefined>;
    const previous = environment.NODE_ENV;
    environment.NODE_ENV = 'production';
    try {
      await knowledge.refreshKnowledge(userId, ree.id, failing);
      await knowledge.processKnowledge(failing);
    } finally {
      environment.NODE_ENV = previous;
    }
    expect((await knowledge.knowledgeDetail(ree.id, failing))?.status).toBe('ready');
  });
});
