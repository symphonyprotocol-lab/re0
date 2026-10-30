/**
 * Articles and audio episodes are assets created from the asset wizard
 * (agent-first-proposal.md 6.5, 6.6; decided 2026-10-30), against a real
 * database:
 *
 * - the wizard's server action creates a post or an episode as a draft in
 *   no channel, with `/posts/{handle}/{slug}` or `/audio/{handle}/{slug}`,
 *   its own source type and an empty working copy, and queues no build;
 * - its refusals read as the wizard's codes: a taken slug, no handle, a
 *   member who may not manage assets, a half-filled rights declaration;
 * - the asset list's rows carry the draft's schedule;
 * - the asset detail route sends a post to its editor;
 * - the separate 文章与音频 page and its URL/RSS import are gone.
 *
 * The session is the one thing faked: `requireSession` reads a cookie, and
 * there is no request here.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

type Session = import('@/lib/application/auth').UserSession;
const current: { session: Session | null } = { session: null };

vi.mock('@/lib/http/session', () => ({
  requireSession: async () => {
    if (!current.session) throw new Error('no session');
    return current.session;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { messagesFor } = await import('@/lib/i18n/dictionary');
  return {
    getMessages: async () => messagesFor('en'),
    translations: async () => ({ locale: 'en', t: messagesFor('en') }),
    currentLocale: async () => 'en',
  };
});

const { createWorkspaceAssetAction } = await import('@/app/dashboard/assets/new/actions');
const { listWorkspaceAssets } = await import('@/lib/application/assets');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');

const stamp = Date.now().toString(36);
const workspaces: string[] = [];
const users: string[] = [];

async function member(label: string, options: { handle: boolean; role?: Session['workspace']['role'] }): Promise<Session> {
  const userId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  users.push(userId);
  workspaces.push(workspaceId);
  const role = options.role ?? 'owner';
  await db().insert(schema.user).values({ id: userId, email: `ed-${label}-${stamp}@example.test`, displayName: `Ed ${label}` });
  await db()
    .insert(schema.workspace)
    .values({ id: workspaceId, name: `Ed ${label}`, handle: options.handle ? `ed-${label}-${stamp}` : null });
  await db().insert(schema.workspaceMember).values({ workspaceId, userId, role });
  return {
    id: crypto.randomUUID(),
    user: { id: userId, email: `ed-${label}-${stamp}@example.test`, displayName: `Ed ${label}`, avatarUrl: null },
    workspace: { id: workspaceId, name: `Ed ${label}`, role } as Session['workspace'],
    expiresAt: new Date(Date.now() + 3_600_000),
  } as Session;
}

function wizardForm(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return form;
}

describeWithDb('articles and audio from the asset wizard', () => {
  let owner: Session;

  beforeAll(async () => {
    owner = await member('owner', { handle: true });
  });

  afterAll(async () => {
    const database = db();
    const assets = (
      await database.select({ id: schema.asset.id }).from(schema.asset).where(inArray(schema.asset.ownerWorkspaceId, workspaces))
    ).map((row) => row.id);
    if (assets.length > 0) {
      await database.delete(schema.postDraft).where(inArray(schema.postDraft.assetId, assets));
      await database.delete(schema.source).where(inArray(schema.source.assetId, assets));
      await database.delete(schema.asset).where(inArray(schema.asset.id, assets));
    }
    await database.delete(schema.workspaceMember).where(inArray(schema.workspaceMember.workspaceId, workspaces));
    await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    await database.delete(schema.user).where(inArray(schema.user.id, users));
  });

  it('creates a post as a draft in no channel, with its public id, and queues nothing', async () => {
    current.session = owner;
    const result = await createWorkspaceAssetAction(
      null,
      wizardForm({ sourceType: 'post', title: 'Hello, readers', slug: 'hello-readers', rightsOrigin: 'own', rightsLicense: 'granted', rightsGeneration: 'human' }),
    );
    expect(result).toMatchObject({ ok: true, editorial: true, publicId: `/posts/ed-owner-${stamp}/hello-readers` });

    const [asset] = await db().select().from(schema.asset).where(eq(schema.asset.id, result.assetId!));
    expect(asset).toMatchObject({ kind: 'post', lifecycleStatus: 'draft', ownerWorkspaceId: owner.workspace.id });
    expect(asset!.rightsDeclaration).toMatchObject({ origin: 'own', license: 'granted', generation: 'human' });
    const [source] = await db().select().from(schema.source).where(eq(schema.source.assetId, asset!.id));
    expect(source?.type).toBe('editor');
    const [draft] = await db().select().from(schema.postDraft).where(eq(schema.postDraft.assetId, asset!.id));
    expect(draft).toMatchObject({ title: 'Hello, readers', publishAt: null });
    expect(await db().select().from(schema.channelAsset).where(eq(schema.channelAsset.assetId, asset!.id))).toHaveLength(0);
    expect(await db().select().from(schema.workflowOperation).where(eq(schema.workflowOperation.assetId, asset!.id))).toHaveLength(0);
  });

  it('creates an audio episode the same way, with a slug made from the title when none is given', async () => {
    current.session = owner;
    const result = await createWorkspaceAssetAction(null, wizardForm({ sourceType: 'audio', title: 'Episode One', slug: '' }));
    expect(result).toMatchObject({ ok: true, editorial: true, publicId: `/audio/ed-owner-${stamp}/episode-one` });
    const [asset] = await db().select().from(schema.asset).where(eq(schema.asset.id, result.assetId!));
    expect(asset).toMatchObject({ kind: 'audio', lifecycleStatus: 'draft' });
    const [source] = await db().select().from(schema.source).where(eq(schema.source.assetId, asset!.id));
    expect(source?.type).toBe('audio');
    expect(await db().select().from(schema.channelAsset).where(eq(schema.channelAsset.assetId, asset!.id))).toHaveLength(0);
  });

  it("words the editorial refusals in the wizard's codes", async () => {
    current.session = owner;
    expect(await createWorkspaceAssetAction(null, wizardForm({ sourceType: 'post', title: 'Again', slug: 'hello-readers' }))).toEqual({
      ok: false,
      error: 'taken',
    });
    expect(await createWorkspaceAssetAction(null, wizardForm({ sourceType: 'post', title: 'Bad', slug: 'Not/A Slug' }))).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(
      await createWorkspaceAssetAction(null, wizardForm({ sourceType: 'audio', title: 'Half', rightsOrigin: 'own' })),
    ).toEqual({ ok: false, error: 'rights' });

    current.session = await member('nohandle', { handle: false });
    expect(await createWorkspaceAssetAction(null, wizardForm({ sourceType: 'post', title: 'No handle' }))).toEqual({
      ok: false,
      error: 'handle',
    });

    current.session = await member('viewer', { handle: true, role: 'viewer' });
    expect(await createWorkspaceAssetAction(null, wizardForm({ sourceType: 'post', title: 'Viewer' }))).toEqual({
      ok: false,
      error: 'denied',
    });
    /* A Q&A is made by answering a question, never from the wizard. */
    current.session = owner;
    expect(await createWorkspaceAssetAction(null, wizardForm({ sourceType: 'qa', title: 'Q' }))).toEqual({ ok: false, error: 'invalid' });
  });

  it("lists the drafts with the other assets, each with its schedule", async () => {
    const rows = await listWorkspaceAssets(owner.workspace.id);
    const post = rows.find((row) => row.kind === 'post')!;
    expect(post).toMatchObject({ publicId: `/posts/ed-owner-${stamp}/hello-readers`, channel: null, publishAt: null, building: false });
    const at = new Date(Date.now() + 86_400_000);
    await db().update(schema.postDraft).set({ publishAt: at }).where(eq(schema.postDraft.assetId, post.id));
    const [again] = (await listWorkspaceAssets(owner.workspace.id)).filter((row) => row.id === post.id);
    expect(again?.publishAt?.getTime()).toBe(at.getTime());
    expect(rows.find((row) => row.kind === 'audio')?.publishAt).toBeNull();
  });

  it('sends the detail route of a post to its editor', async () => {
    current.session = owner;
    const [post] = await db()
      .select({ id: schema.asset.id })
      .from(schema.asset)
      .where(eq(schema.asset.publicId, `/posts/ed-owner-${stamp}/hello-readers`));
    const { default: DetailPage } = await import('@/app/dashboard/assets/[assetId]/page');
    const redirected = await DetailPage({ params: Promise.resolve({ assetId: post!.id }), searchParams: Promise.resolve({}) }).then(
      () => null,
      (error: unknown) => error as { digest?: string },
    );
    expect(redirected?.digest).toContain(`/dashboard/assets/${post!.id}/edit`);
  });
});

describe('the separate posts page', () => {
  it('is gone, with its URL and RSS import', () => {
    expect(existsSync('app/dashboard/posts')).toBe(false);
    expect(existsSync('lib/application/editorial/import.ts')).toBe(false);
  });
});
