/**
 * The independent review of the workspace's second phase (PR #260), one test
 * per finding: a bound file the owner trashed stays out of the Ree; the
 * secret scan reads the indexed version; deleted and taken-down Rees index
 * nothing; a day's indexing is one charge, rounded up once; only files that
 * may need the index are queued, in turns across workspaces; a Ree sync
 * reads only changed files, a batch at a time; vectors paid for are kept
 * when the swap fails; concurrent workers cannot pass the daily budget; and
 * the hardening (bounded estimates, no second copy of a file's text, an
 * idempotent "移到工作区", files left in an old embedding space re-embedded).
 * Embeddings come from the fake model server.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const objects = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/lib/infra/workspace-store', () => ({
  workspaceObjectPath: (workspaceId: string, sha: string) => `workspace/${workspaceId.toLowerCase()}/${sha}`,
  putWorkspaceObject: async (path: string, bytes: Uint8Array) => void objects.set(path, bytes),
  readWorkspaceObject: async (path: string) => objects.get(path) ?? null,
  deleteWorkspaceObjects: async (paths: readonly string[]) => paths.forEach((path) => objects.delete(path)),
}));
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: () => undefined }));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const workspace = await import('@/lib/services/workspace');
const index = await import('@/lib/services/workspace-index');
const wsRees = await import('@/lib/services/workspace-rees');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const library = await import('@/lib/services/knowledge-library');
const { db, schema } = await import('@/lib/infra/db');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { forgetRateLimitSettings } = await import('@/lib/services/rate-limit-settings');
const { addGrant } = await import('@/lib/services/credits');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(() => fake?.close());

async function person(credits = 1_000) {
  const subject = uniqueName('wsr');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'en', '/');
  if (credits) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return { userId, scope: await workspace.webScope(userId) };
}

const embedded = () => fake.requests.filter((request) => request.path.endsWith('/embeddings')).flatMap((request) => request.inputs ?? []);
const soon = () => new Date(Date.now() + 3 * 60_000);
/** Runs the index cron as if the two quiet minutes had passed. */
const indexNow = (limit = 100) => index.runIndexQueue(soon(), { limit });

async function setCeiling(key: string, value: number | null) {
  if (value === null) await db().delete(schema.limitCeilingSetting).where(eq(schema.limitCeilingSetting.key, key));
  else await db().insert(schema.limitCeilingSetting).values({ key, value }).onConflictDoUpdate({ target: schema.limitCeilingSetting.key, set: { value } });
  forgetRateLimitSettings();
}

const entryAt = async (scope: { workspaceId: string }, path: string) =>
  (await db().select().from(schema.workspaceEntry).where(and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), eq(schema.workspaceEntry.path, path))))[0]!;
const sourcesOf = (reeId: string) => db().select().from(schema.knowledge).where(eq(schema.knowledge.reeId, reeId));
const folderRee = async (scope: Awaited<ReturnType<typeof person>>['scope'], path: string) =>
  (await wsRees.createReeFromFolder(scope, { path, name: uniqueName('Ree').slice(0, 40), category: 'travel' })).ree;

describeWithDb('review fixes: what reaches a Ree', () => {
  it('1. keeps a bound file the owner trashed out of the Ree, through syncs and the purge, until it is restored or bound again', async () => {
    const { userId, scope } = await person();
    await workspace.writeFile(scope, { path: '/f/a.md', content: 'Alpha notes about Asunción.' });
    await workspace.writeFile(scope, { path: '/f/b.md', content: 'Beta notes about Encarnación.' });
    const ree = await folderRee(scope, '/f');
    await indexNow();
    const a = (await sourcesOf(ree.id)).find((row) => row.title === 'a.md')!;
    await library.runBatch(userId, ree.id, { action: 'trash', ids: [a.id] });
    /* An edit, an index run and a move all sync the Ree: the trashed file stays trashed. */
    await workspace.writeFile(scope, { path: '/f/a.md', content: 'Alpha notes about Asunción, edited.' });
    await indexNow();
    await workspace.moveEntry(scope, { from: '/f/b.md', to: '/f/b2.md' });
    await indexNow();
    const live = async () => (await sourcesOf(ree.id)).filter((row) => !row.deletedAt).map((row) => row.title).sort();
    expect(await live()).toEqual(['b2.md']);
    /* The purge removes the trashed row for good: the file is still not added again. */
    await db().delete(schema.knowledge).where(eq(schema.knowledge.id, a.id));
    await wsRees.syncRee(ree.id);
    expect(await live()).toEqual(['b2.md']);
    /* Binding the path again is the owner asking for it back. */
    await wsRees.bindPaths(scope, ree.id, { add: ['/f/a.md'] });
    expect(await live()).toEqual(['a.md', 'b2.md']);

    /* Restoring a trashed source from the Ree's trash brings it back, and it follows its file again. */
    const b = (await sourcesOf(ree.id)).find((row) => row.title === 'b2.md')!;
    await library.runBatch(userId, ree.id, { action: 'trash', ids: [b.id] });
    await library.runBatch(userId, ree.id, { action: 'restore', ids: [b.id] });
    await workspace.writeFile(scope, { path: '/f/b2.md', content: 'Beta notes, edited after the restore.' });
    await indexNow();
    const [back] = await db().select().from(schema.knowledge).where(eq(schema.knowledge.id, b.id));
    expect(back).toMatchObject({ deletedAt: null });
    expect((await knowledge.knowledgeText(ree.id, b.id))!.content).toContain('edited after the restore');
  });

  it('2. scans the version the index holds, not the newer text, and keeps no second copy of it', async () => {
    const { userId, scope } = await person();
    await workspace.writeFile(scope, { path: '/s/notes.md', content: `Deploy notes.\nkey: sk-${'b'.repeat(40)}\n` });
    await index.setIndexMode(scope, { path: '/s', mode: 'on' });
    await indexNow();
    /* v2 drops the secret but is not indexed yet. */
    await workspace.writeFile(scope, { path: '/s/notes.md', content: 'Deploy notes, cleaned.\n' });
    const { ree } = await rees.createRee(userId, { name: uniqueName('Pub').slice(0, 40), description: 'x', category: 'travel', tags: [], systemPrompt: '', sampleQuestions: [], queryFee: 0, isPublic: true, color: 'default' });
    await rees.setReePublished(userId, ree.id, true);
    await wsRees.bindPaths(scope, ree.id, { add: ['/s'], autoEnable: true });
    const [source] = await sourcesOf(ree.id);
    /* What the Ree would answer from is v1, so v1 is what was scanned. */
    expect(source).toMatchObject({ secretFound: 'openai_key', enabled: false, awaitingConfirmation: true, content: null });
    expect((await knowledge.knowledgeText(ree.id, source!.id))!.content).toContain('sk-');
    /* Once v2 is indexed the source follows it, and the scan with it. */
    await indexNow();
    const [after] = await sourcesOf(ree.id);
    expect(after!.secretFound).toBeNull();
    expect((await knowledge.knowledgeText(ree.id, after!.id))!.content).toBe('Deploy notes, cleaned.');
    expect((await knowledge.knowledgeDetail(ree.id, after!.id))!.chars).toBe('Deploy notes, cleaned.'.length);
  });

  it('3. stops indexing for a deleted Ree (its bindings go) and for a taken-down one', async () => {
    const { userId, scope } = await person();
    await workspace.writeFile(scope, { path: '/d/a.md', content: 'Only a Ree keeps this indexed.' });
    const ree = await folderRee(scope, '/d');
    await indexNow();
    const entry = await entryAt(scope, '/d/a.md');
    expect(entry.indexedRevisionId).not.toBeNull();
    expect(await rees.deleteRee(userId, ree.id)).toBe(true);
    expect(await db().select().from(schema.reeBinding).where(eq(schema.reeBinding.reeId, ree.id))).toEqual([]);
    const before = embedded().length;
    await indexNow();
    expect((await entryAt(scope, '/d/a.md')).indexedRevisionId).toBeNull();
    expect(await db().select().from(schema.workspacePassage).where(eq(schema.workspacePassage.entryId, entry.id))).toEqual([]);
    await workspace.writeFile(scope, { path: '/d/a.md', content: 'Edited after the Ree went.' });
    expect((await entryAt(scope, '/d/a.md')).indexDueAt).toBeNull();
    expect(embedded().length).toBe(before);

    /* Taken down: its bindings stay, but index nothing while it is down. */
    await workspace.writeFile(scope, { path: '/t/a.md', content: 'Kept indexed by a Ree that gets taken down.' });
    const down = await folderRee(scope, '/t');
    await indexNow();
    await db().update(schema.ree).set({ moderatedAt: new Date() }).where(eq(schema.ree.id, down.id));
    await workspace.writeFile(scope, { path: '/t/a.md', content: 'Edited while the Ree is down.' });
    await indexNow();
    expect((await entryAt(scope, '/t/a.md')).indexedRevisionId).toBeNull();
  });

  it('6. syncs only the files whose index changed, in batches, however many the Ree has', async () => {
    const { scope } = await person();
    for (let i = 0; i < 55; i += 1) await workspace.writeFile(scope, { path: `/many/f${String(i).padStart(2, '0')}.md`, content: `File number ${i} about the Pantanal.` });
    const ree = await folderRee(scope, '/many');
    await indexNow();
    expect((await sourcesOf(ree.id)).filter((row) => !row.deletedAt)).toHaveLength(55);
    expect(await wsRees.syncRee(ree.id)).toEqual({ added: 0, updated: 0, removed: 0, waiting: 0 });
    await workspace.writeFile(scope, { path: '/many/f07.md', content: 'File number 7, rewritten.' });
    const touched = await db().select({ id: schema.workspaceEntry.id }).from(schema.workspaceEntry).where(and(eq(schema.workspaceEntry.workspaceId, scope.workspaceId), eq(schema.workspaceEntry.path, '/many/f07.md')));
    await index.indexEntry(touched[0]!.id, soon());
    expect(await wsRees.syncRee(ree.id)).toEqual({ added: 0, updated: 1, removed: 0, waiting: 0 });
  }, 120_000);
});

describeWithDb('review fixes: what indexing costs', () => {
  it('4. bills a day of small edits as one run, rounded up once, not a credit per file', async () => {
    const { userId, scope } = await person();
    await workspace.makeFolder(scope, { path: '/n' });
    await index.setIndexMode(scope, { path: '/n', mode: 'on' });
    for (let i = 0; i < 30; i += 1) await workspace.writeFile(scope, { path: `/n/${i}.md`, content: `Note ${i}: a short line.` });
    const counts = await indexNow();
    expect(counts.indexed).toBeGreaterThanOrEqual(30);
    const runs = () => db().select().from(schema.knowledgeCostRun).where(and(eq(schema.knowledgeCostRun.userId, userId), eq(schema.knowledgeCostRun.kind, 'workspace_index')));
    expect(await runs()).toHaveLength(1);
    const spent = (await index.indexBudget(userId)).spent;
    expect(spent).toBeGreaterThan(0);
    /* Settled the next day, once. */
    expect(await index.closeIndexRuns(new Date(Date.now() + 24 * 60 * 60_000))).toBeGreaterThanOrEqual(1);
    const [run] = await runs();
    expect(run).toMatchObject({ status: 'ready' });
    /* What the supplier billed, rounded up once (the fake bills 1,000 tokens a call), against 30 credits as a credit per file. */
    const recorded = run!.charges.reduce((sum, charge) => sum + Number(charge.costUsd), 0) / 0.0001;
    expect(run!.chargedCredits).toBe(Math.ceil(recorded - 1e-9));
    expect(run!.chargedCredits).toBeLessThan(30);
    expect(spent).toBeGreaterThanOrEqual(recorded - 0.01);
  }, 120_000);

  it('7. keeps vectors it paid for when the swap fails, so the retry embeds nothing', async () => {
    const { scope } = await person();
    await workspace.makeFolder(scope, { path: '/p' });
    await index.setIndexMode(scope, { path: '/p', mode: 'on' });
    await workspace.writeFile(scope, { path: '/p/a.md', content: 'Paid-for passage about the Itaipú dam.' });
    await indexNow();
    const a = await entryAt(scope, '/p/a.md');
    /* As if a run had embedded and staged b.md's passages, then failed before swapping them in. */
    await workspace.writeFile(scope, { path: '/p/b.md', content: 'Paid-for passage about the Itaipú dam.' });
    const b = await entryAt(scope, '/p/b.md');
    const [passage] = await db().select().from(schema.workspacePassage).where(eq(schema.workspacePassage.entryId, a.id));
    await db().insert(schema.workspacePassage).values({ ...passage!, entryId: b.id, ordinal: index.PASSAGE_STAGED, revisionId: b.currentRevisionId! });
    await workspace.trashEntry(scope, { path: '/p/a.md' });
    await db().delete(schema.workspacePassage).where(eq(schema.workspacePassage.entryId, a.id));
    const before = embedded().length;
    expect((await indexNow()).indexed).toBeGreaterThanOrEqual(1);
    expect(embedded().length).toBe(before);
    const rows = await db().select().from(schema.workspacePassage).where(eq(schema.workspacePassage.entryId, b.id));
    expect(rows.map((row) => row.ordinal)).toEqual([0]);
  });

  it('8. lets only one of two concurrent workers through when the budget fits one', async () => {
    const { userId, scope } = await person();
    await workspace.makeFolder(scope, { path: '/c' });
    await index.setIndexMode(scope, { path: '/c', mode: 'on' });
    await workspace.writeFile(scope, { path: '/c/one.md', content: 'Concurrent file one about yerba mate.' });
    await workspace.writeFile(scope, { path: '/c/two.md', content: 'Concurrent file two about yerba mate!' });
    /* Each reserves its quote: tokens at the fixture's $0.02 per million, in credits of $0.0001. */
    const quote = async (path: string) => ((await index.estimateIndex(scope, path)).tokens * 0.00000002) / 0.0001;
    const [first, second] = [await quote('/c/one.md'), await quote('/c/two.md')];
    await setCeiling('workspaceIndexBudget', 1);
    try {
      /* Room for one and a half of them: either fits alone, not both. */
      await db().insert(schema.workspaceUsage).values({ userId }).onConflictDoNothing();
      await db().update(schema.workspaceUsage).set({ indexSpentDay: new Date().toISOString().slice(0, 10), indexSpent: 1 - Math.max(first, second) * 1.5 }).where(eq(schema.workspaceUsage.userId, userId));
      expect(Math.max(first, second) * 1.5).toBeLessThan(first + second);
      const ids = [(await entryAt(scope, '/c/one.md')).id, (await entryAt(scope, '/c/two.md')).id];
      const outcomes = await Promise.all(ids.map((id) => index.indexEntry(id, soon())));
      expect(outcomes.sort()).toEqual(['budget', 'indexed']);
    } finally {
      await setCeiling('workspaceIndexBudget', null);
    }
  });
});

describeWithDb('review fixes: the queue', () => {
  it('5. queues only files that may need the index, and takes workspaces in turns', async () => {
    const quiet = await person();
    await workspace.writeFile(quiet.scope, { path: '/plain/a.md', content: 'Nobody indexes this.' });
    expect((await entryAt(quiet.scope, '/plain/a.md')).indexDueAt).toBeNull();
    await workspace.moveEntry(quiet.scope, { from: '/plain', to: '/plain2' });
    expect((await entryAt(quiet.scope, '/plain2/a.md')).indexDueAt).toBeNull();

    const busy = await person();
    await workspace.makeFolder(busy.scope, { path: '/b' });
    await index.setIndexMode(busy.scope, { path: '/b', mode: 'on' });
    for (let i = 0; i < 6; i += 1) await workspace.writeFile(busy.scope, { path: `/b/${i}.md`, content: `Busy file ${i}.` });
    const small = await person();
    await workspace.makeFolder(small.scope, { path: '/q' });
    await index.setIndexMode(small.scope, { path: '/q', mode: 'on' });
    await workspace.writeFile(small.scope, { path: '/q/s.md', content: 'The one file of a quiet account.' });
    /* Other test files share the database and the queue: these two workspaces' files are made due in 2000, and the run looks then, so only they are due. */
    const then = new Date('2000-01-01T00:00:00Z');
    await db().update(schema.workspaceEntry).set({ indexDueAt: new Date('1999-12-31T00:00:00Z') }).where(and(inArray(schema.workspaceEntry.workspaceId, [busy.scope.workspaceId, small.scope.workspaceId]), eq(schema.workspaceEntry.kind, 'file')));
    await index.runIndexQueue(then, { limit: 2 });
    expect((await entryAt(small.scope, '/q/s.md')).indexDueAt).toBeNull();
    const busyLeft = await db().select().from(schema.workspaceEntry).where(and(eq(schema.workspaceEntry.workspaceId, busy.scope.workspaceId), eq(schema.workspaceEntry.kind, 'file'), gte(schema.workspaceEntry.indexDueAt, new Date(0))));
    expect(busyLeft).toHaveLength(5);
  });
});

describeWithDb('review fixes: hardening', () => {
  it('estimates a folder of more files than one page, a page at a time', async () => {
    const { scope } = await person();
    for (let i = 0; i < 205; i += 1) await workspace.writeFile(scope, { path: `/e/${i}.md`, content: `Estimate file ${i}.` });
    const estimate = await index.estimateIndex(scope, '/e');
    expect(estimate).toMatchObject({ files: 205, reused: 0 });
    expect(estimate.tokens).toBeGreaterThan(205);
  }, 120_000);

  it('finishes "移到工作区" on a second run after the first stopped midway, without a second copy', async () => {
    const { userId, scope } = await person();
    const { ree } = await rees.createRee(userId, { name: uniqueName('Old').slice(0, 40), description: 'x', category: 'travel', tags: [], systemPrompt: '', sampleQuestions: [], queryFee: 0, isPublic: false, color: 'default' });
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Notes', content: 'Text to move once.' });
    await knowledge.processKnowledge(id, { profile: false });
    /* The first run wrote the file, then stopped before turning the source into it. */
    await workspace.writeFile(scope, { path: `/Rees/${ree.slug}/Notes.md`, content: 'Text to move once.' });
    expect(await wsRees.moveReeToWorkspace(userId, ree.id)).toMatchObject({ moved: 1 });
    const files = await workspace.listEntries(scope, { path: `/Rees/${ree.slug}` });
    expect(files.entries.map((entry: { name: string }) => entry.name)).toEqual(['Notes.md']);
    const [source] = await db().select().from(schema.knowledge).where(eq(schema.knowledge.id, id));
    expect(source).toMatchObject({ kind: 'file', content: null });
    expect(await wsRees.moveReeToWorkspace(userId, ree.id)).toMatchObject({ moved: 0 });
    expect(await db().select().from(schema.reeBinding).where(eq(schema.reeBinding.reeId, ree.id))).toHaveLength(1);
  });

  it('re-embeds files left in an old embedding space, a batch at a time, and finds them by keyword meanwhile', async () => {
    const { scope } = await person();
    await workspace.makeFolder(scope, { path: '/old' });
    await index.setIndexMode(scope, { path: '/old', mode: 'on' });
    await workspace.writeFile(scope, { path: '/old/a.md', content: 'Ñandutí lace is made in Itauguá.' });
    await indexNow();
    const entry = await entryAt(scope, '/old/a.md');
    const oldSpace = crypto.randomUUID();
    await db().update(schema.workspacePassage).set({ embeddingSpace: oldSpace }).where(eq(schema.workspacePassage.entryId, entry.id));
    const found = await index.searchPassages(scope, { query: 'Itauguá lace' });
    expect(found.passages.map((passage) => passage.path)).toContain('/old/a.md');
    expect(await index.queueStaleSpaces(new Date())).toBeGreaterThanOrEqual(1);
    const before = embedded().length;
    await indexNow();
    expect(embedded().length).toBeGreaterThan(before);
    const rows = await db().select().from(schema.workspacePassage).where(eq(schema.workspacePassage.entryId, entry.id));
    expect(rows.every((row) => row.embeddingSpace !== oldSpace)).toBe(true);
  });
});
