/**
 * Acceptance (8.4 step 2), the four kinds that reach outside:
 *   - a public repository needs no GitHub connection (read with the
 *     server's optional token, or none); a private one needs the owner's
 *     connection and is read with their token; both are cited by file and line;
 *   - a single page needs no claim; a website is refused until its domain is
 *     verified, by DNS TXT or by the well-known file, either one;
 *   - a 100 MB audio file is cut into ten-minute pieces, transcribed with
 *     timestamps stitched across them, and a passage starting at 377 s cites
 *     "第 6:17".
 * GitHub, the sites and DNS are stubbed; transcription and embeddings go to
 * the local fake endpoint.
 */
import { KNOWLEDGE_SLOT_POOLS, WELCOME_CREDITS } from '@/lib/constants';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, asc, eq } from 'drizzle-orm';
import { FAKE_MP3_FRAME_SECONDS, FAKE_MP3_PIECE_FRAMES, fakeMp3, startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { authorization, html, jsonResponse, startFakeWeb, text, type FakeWeb } from '../fixtures/fake-web';
import { expectChargedAtLeastCost } from './billing-audit';

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
const connections = await import('@/lib/services/connections');
const { listGithubRepositories } = await import('@/lib/infra/connectors/github');
const rees = await import('@/lib/services/rees');
const chat = await import('@/lib/services/chat');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { locatorLabel } = await import('@/lib/domain/answer');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { checkWellKnownChallenge } = await import('@/lib/infra/verification/challenge');

let fake: FakeOpenAi;
let web: FakeWeb;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
  web = startFakeWeb(['api.github.com', 'raw.githubusercontent.com', 'blog.example.org', 'docs.example.com', 'example.net']);
});
afterAll(async () => {
  web?.restore();
  await fake?.close();
});

async function userWithRee(extraCredits = 0) {
  const subject = uniqueName('kk');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'K', avatarUrl: null }, 'zh', '/');
  await rees.saveDraft(userId, { ...newReeDraft(), name: 'Sources', category: 'technology', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(userId);
  if (extraCredits > 0) {
    await db().insert(schema.creditGrant).values({ userId, source: 'pack', amount: extraCredits, remaining: extraCredits });
  }
  return { userId, ree };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return 'accepted';
}

/* ------------------------------------------------------------------ GitHub */

const README = '# Acme handbook\n\nIntro line.\n\n## Deploys\n\nDeploys run every Tuesday at noon from the release branch.\n';
const SOURCE = 'export function greet(name: string) {\n  return `hello ${name}`;\n}\n';

/** Authorization headers GitHub saw, null for anonymous requests. */
const githubAuth: (string | null)[] = [];

/** A public repository answers anyone; a private one only the tokens in `readers`. */
function serveRepository(owner: string, name: string, visibility: 'public' | 'private', readers: readonly string[] = ['gho_secret_token']) {
  const repo = `api.github.com/repos/${owner}/${name}`;
  const allowed = (init: RequestInit | undefined) => {
    const auth = authorization(init);
    githubAuth.push(auth);
    return visibility === 'public' || readers.some((token) => auth === `Bearer ${token}`);
  };
  web.routes.set(repo, (_url, init) =>
    allowed(init) ? jsonResponse({ full_name: `${owner}/${name}`, private: visibility === 'private', default_branch: 'main' }) : jsonResponse({ message: 'Not Found' }, 404),
  );
  web.routes.set(`${repo}/branches/main`, (_url, init) => (allowed(init) ? jsonResponse({ commit: { sha: 'abc1234def' } }) : jsonResponse({}, 404)));
  web.routes.set(`${repo}/git/trees/abc1234def?recursive=1`, (_url, init) =>
    allowed(init)
      ? jsonResponse({
          tree: [
            { path: 'README.md', type: 'blob', size: README.length },
            { path: 'src/greet.ts', type: 'blob', size: SOURCE.length },
            { path: 'node_modules/x/index.js', type: 'blob', size: 10 },
            { path: 'logo.png', type: 'blob', size: 10 },
          ],
        })
      : jsonResponse({}, 404),
  );
  for (const [path, content] of [['README.md', README], ['src/greet.ts', SOURCE]] as const) {
    const file = visibility === 'private'
      ? `${repo}/contents/${path}?ref=abc1234def`
      : `raw.githubusercontent.com/${owner}/${name}/abc1234def/${path}`;
    web.routes.set(file, (_url, init) => (
      allowed(init) && (visibility === 'public' || new Headers(init?.headers).get('accept') === 'application/vnd.github.raw+json')
        ? text(content)
        : jsonResponse({}, 404)
    ));
  }
}

describeWithDb('GitHub repositories', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_READ_TOKEN', '');
    githubAuth.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it('imports a public repository without a GitHub connection and cites file and line', async () => {
    serveRepository('acme', 'handbook', 'public');
    const { userId, ree } = await userWithRee();
    const input = { kind: 'github', url: 'https://github.com/acme/handbook' } as const;
    const id = await knowledge.addKnowledge(userId, ree, input);
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 1);
    await knowledge.processKnowledge(id);
    /* Repository, branch and tree through the API, the two bodies from raw.githubusercontent.com, all anonymous. */
    expect(githubAuth).toEqual([null, null, null, null, null, null]);
    expect(web.requests.filter((url) => url.includes('raw.githubusercontent.com/acme/handbook/abc1234def/'))).toHaveLength(2);
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail).toMatchObject({ status: 'ready', title: 'acme/handbook', source: 'https://github.com/acme/handbook' });
    expect(detail!.children.map((child) => child.path)).toEqual(['README.md', 'src/greet.ts']);
    const deploys = detail!.chunks.find((chunk) => chunk.content.includes('Tuesday'));
    expect(deploys?.locator).toMatchObject({ path: 'README.md', line: 5, heading: 'Acme handbook › Deploys' });
    expect(locatorLabel(deploys!.locator, 'zh')).toContain('README.md:5');
    const file = await knowledge.knowledgeChild(ree.id, id, 1);
    expect(file?.content).toBe(SOURCE.trimEnd());
    // Receipts: the files fetched from GitHub (transfer) and the embedding.
    expect(await expectChargedAtLeastCost(id)).toEqual([expect.objectContaining({ status: 'ready', receipts: 2 })]);

    /* Connected, the owner's token is used; disconnected again, refreshing still works. */
    await connections.saveGithubConnection(userId, { accessToken: 'gho_secret_token', login: 'acme-dev', scope: 'repo' });
    githubAuth.length = 0;
    await knowledge.refreshKnowledge(userId, ree.id, id);
    await knowledge.processKnowledge(id);
    expect(new Set(githubAuth)).toEqual(new Set(['Bearer gho_secret_token']));
    await connections.disconnectGithub(userId);
    await knowledge.refreshKnowledge(userId, ree.id, id);
    await knowledge.processKnowledge(id);
    expect((await knowledge.knowledgeDetail(ree.id, id))?.status).toBe('ready');
  });

  it('imports one folder of a branch, keeps that scope on reprocess, and refuses a ref that does not exist', async () => {
    const sha = 'f00dfeed'.repeat(5);
    const repo = 'api.github.com/repos/acme/manual';
    web.routes.set(repo, () => jsonResponse({ full_name: 'acme/manual', private: false, default_branch: 'main' }));
    web.routes.set(`${repo}/git/matching-refs/heads/main`, () => jsonResponse([{ ref: 'refs/heads/main' }, { ref: 'refs/heads/main-old' }]));
    web.routes.set(`${repo}/commits/main`, () => text(sha));
    web.routes.set(`${repo}/git/trees/${sha}?recursive=1`, () => jsonResponse({
      tree: ['README.md', 'docs/guide.md', 'docs/CHANGELOG.md', 'docs/guide.test.ts', 'src/index.ts'].map((path) => ({ path, type: 'blob', size: 64 })),
    }));
    web.routes.set(`raw.githubusercontent.com/acme/manual/${sha}/docs/guide.md`, () => text('# Guide\n\nSet VITE_API_URL in .env to point at the API.\n'));
    const { userId, ree } = await userWithRee();
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'https://github.com/acme/manual/tree/main/docs' });
    await knowledge.processKnowledge(id, { profile: false });
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail).toMatchObject({ status: 'ready', title: 'acme/manual/docs @ main', source: 'https://github.com/acme/manual/tree/main/docs' });
    /* Only the folder, and in it neither the changelog nor the test. */
    expect(detail!.children.map((child) => child.path)).toEqual(['docs/guide.md']);
    expect(web.requests.some((url) => url.includes(`/${sha}/README.md`))).toBe(false);

    await knowledge.refreshKnowledge(userId, ree.id, id);
    await knowledge.processKnowledge(id, { profile: false });
    expect((await knowledge.knowledgeDetail(ree.id, id))!.children.map((child) => child.path)).toEqual(['docs/guide.md']);

    /* A mistyped branch is refused when it is added, before anything is reserved. */
    const before = await balanceOf(db(), userId);
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'https://github.com/acme/manual/tree/mian' }))).toBe('github_ref_not_found');
    expect(await balanceOf(db(), userId)).toBe(before);
  });

  it('runs a burst of repositories a few at a time per owner, and a dead run frees its slot', async () => {
    serveRepository('acme', 'burst', 'public');
    const { userId, ree } = await userWithRee();
    const ids: string[] = [];
    const owned = KNOWLEDGE_SLOT_POOLS.crawl.owner;
    for (let at = 0; at <= owned; at += 1) ids.push(await knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'acme/burst' }));
    const busy = ids.slice(0, owned);
    const waiting = ids.at(-1)!;
    /* The owner's other repositories are being processed, beating their heartbeats. */
    for (const [at, id] of busy.entries()) {
      await db().update(schema.knowledge).set({ status: 'processing', activity: [{ code: 'processing', at: new Date().toISOString(), detail: { runId: `burst-${at}-${id}` } }] }).where(eq(schema.knowledge.id, id));
      await db().update(schema.knowledgeCostRun).set({ status: 'processing', runId: `burst-${at}-${id}`, heartbeatAt: new Date() }).where(eq(schema.knowledgeCostRun.knowledgeId, id));
    }
    expect(await knowledge.processKnowledge(waiting, { profile: false })).toBeNull();
    expect(await knowledge.knowledgeDetail(ree.id, waiting)).toMatchObject({ status: 'pending' });
    /* The queue does not offer it while the owner has no free slot. */
    expect(await knowledge.queuedKnowledge(500)).not.toContain(waiting);
    /* Other kinds do not wait for a slot. */
    const note = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Note', content: 'Text never queues behind repositories.' });
    expect(await knowledge.processKnowledge(note, { profile: false })).toBe(ree.id);
    /* The queue offers them only once their own after-response run has had a minute to take them. */
    const missed = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Missed', content: 'Its after-response run never started.' });
    expect(await knowledge.queuedKnowledge(500)).not.toContain(missed);
    await db().update(schema.knowledge).set({ updatedAt: new Date(Date.now() - 2 * 60_000) }).where(eq(schema.knowledge.id, missed));
    expect(await knowledge.queuedKnowledge(500)).toContain(missed);
    await knowledge.processQueued([missed, waiting]);
    expect(await knowledge.knowledgeDetail(ree.id, missed)).toMatchObject({ status: 'ready' });
    expect(await knowledge.knowledgeDetail(ree.id, waiting)).toMatchObject({ status: 'pending' });

    /* One run stops beating: it no longer holds a slot, and the waiting repository starts. */
    await db().update(schema.knowledgeCostRun).set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) }).where(eq(schema.knowledgeCostRun.knowledgeId, busy[0]!));
    expect(await knowledge.queuedKnowledge(500)).toContain(waiting);
    expect(await knowledge.processKnowledge(waiting, { profile: false })).toBe(ree.id);
    expect(await knowledge.knowledgeDetail(ree.id, waiting)).toMatchObject({ status: 'ready' });
    expect(await knowledge.queuedKnowledge(500)).not.toContain(waiting);

    /* The stand-in runs are failed and their reservations returned, so nothing is left open. */
    await knowledge.recoverStale(ree.id, new Date(Date.now() + 30 * 60_000), { resume: false });
    for (const id of busy) expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'failed', error: 'interrupted' });
  });

  it('reads public repositories with GITHUB_READ_TOKEN, but never a private one on an owner\'s behalf', async () => {
    vi.stubEnv('GITHUB_READ_TOKEN', 'github_pat_server');
    serveRepository('acme', 'guide', 'public');
    serveRepository('acme', 'internal', 'private', ['gho_secret_token', 'github_pat_server']);
    const { userId, ree } = await userWithRee();
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'acme/guide' });
    await knowledge.processKnowledge(id);
    expect((await knowledge.knowledgeDetail(ree.id, id))?.status).toBe('ready');
    expect(githubAuth).toHaveLength(6);
    expect(new Set(githubAuth)).toEqual(new Set(['Bearer github_pat_server']));

    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'acme/internal' }))).toBe('github_not_connected');
  });

  it('refuses a private repository until GitHub is connected, then reads it with the token', async () => {
    serveRepository('acme', 'secret', 'private');
    const { userId, ree } = await userWithRee();
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'https://github.com/acme/secret' }))).toBe('github_not_connected');
    /* The same answer as for a repository that does not exist: nothing says a private one is there. */
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'acme/nowhere' }))).toBe('github_not_connected');
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS);

    await connections.saveGithubConnection(userId, { accessToken: 'gho_secret_token', login: 'acme-dev', scope: 'repo' });
    expect(await connections.githubConnectionFor(userId)).toMatchObject({ login: 'acme-dev' });
    const [stored] = await db().select().from(schema.githubConnection).where(eq(schema.githubConnection.userId, userId));
    expect(stored!.encryptedToken).not.toContain('gho_secret_token');

    const id = await knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'acme/secret' });
    await knowledge.processKnowledge(id);
    expect((await knowledge.knowledgeDetail(ree.id, id))?.status).toBe('ready');

    /* Disconnecting stops refreshes (2.2). */
    await connections.disconnectGithub(userId);
    expect(await refusal(knowledge.refreshKnowledge(userId, ree.id, id))).toBe('github_not_connected');
  });

  it('stops queued private repository processing if GitHub was disconnected', async () => {
    serveRepository('acme', 'queued', 'private');
    const { userId, ree } = await userWithRee();
    await connections.saveGithubConnection(userId, { accessToken: 'gho_secret_token', login: 'acme-dev', scope: 'repo' });
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'acme/queued' });
    await connections.disconnectGithub(userId);

    githubAuth.length = 0;
    await knowledge.processKnowledge(id);
    /* One anonymous look at the repository, which GitHub does not show: no file is read. */
    expect(githubAuth).toEqual([null]);
    expect((await knowledge.knowledgeDetail(ree.id, id))).toMatchObject({ status: 'failed', error: 'github_not_connected' });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS);
  });

  it('reports an exhausted GitHub rate limit as a temporary access failure', async () => {
    web.routes.set('api.github.com/repos/acme/busy', () =>
      new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    );
    const { userId, ree } = await userWithRee();
    await connections.saveGithubConnection(userId, { accessToken: 'gho_secret_token', login: 'acme-dev', scope: 'repo' });
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'acme/busy' }))).toBe('source_unreachable');
  });

  it('says not found for a repository the connected account cannot read', async () => {
    const { userId, ree } = await userWithRee();
    await connections.saveGithubConnection(userId, { accessToken: 'gho_other', login: 'someone', scope: 'repo' });
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'https://github.com/acme/secret' }))).toBe('github_repo_not_found');
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'https://gitlab.com/acme/secret' }))).toBe('invalid_github_url');
    web.routes.set('api.github.com/repos/acme/restricted', () => jsonResponse({}, 403));
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'acme/restricted' }))).toBe('github_repo_not_found');
  });

  it('lists personal and organization repositories using the connected user token and follows pagination', async () => {
    const token = 'ghu_repository_grant';
    const { userId } = await userWithRee();
    await connections.saveGithubConnection(userId, { accessToken: token, login: 'acme-dev', scope: 'github_app' });
    web.routes.set('api.github.com/user/repos', (url, init) => {
      if (authorization(init) !== `Bearer ${token}`) return jsonResponse({}, 401);
      if (url.searchParams.get('page') === '2') return jsonResponse([{ full_name: 'another-org/private-docs' }]);
      return new Response(JSON.stringify([{ full_name: 'acme-dev/notes' }, { full_name: 'acme/handbook' }]), {
        headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
      });
    });
    const connectedToken = await connections.githubTokenFor(userId);
    expect(await listGithubRepositories(connectedToken!, 1)).toEqual({
      repositories: ['acme-dev/notes', 'acme/handbook'],
      nextPage: 2,
    });
    expect(await listGithubRepositories(connectedToken!, 2)).toEqual({
      repositories: ['another-org/private-docs'],
      nextPage: null,
    });
  });
});

/* ----------------------------------------------------------- pages, sites */

const PAGE = `<!doctype html><html><head><title>Release notes</title></head><body>
<nav><a href="/">Home</a> navigation chrome</nav>
<main><h1>Release notes</h1><p>Version 4 adds offline sync for field teams, with conflicts resolved on the server.</p>
<pre><code>npm install acme@4</code></pre></main><footer>© Example</footer></body></html>`;

function sitePage(title: string, body: string, links: string[] = []): string {
  return `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body}</p>${links.map((href) => `<a href="${href}">${href}</a>`).join(' ')}</main></body></html>`;
}

describeWithDb('pages and websites', () => {
  it('fetches a single page without any claim and keeps its main content', async () => {
    web.routes.set('blog.example.org/notes', () => html(PAGE));
    const { userId, ree } = await userWithRee();
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'page', url: 'https://blog.example.org/notes#v4' });
    await knowledge.processKnowledge(id);
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail).toMatchObject({ status: 'ready', title: 'Release notes', source: 'https://blog.example.org/notes' });
    expect(detail!.content).toContain('offline sync');
    expect(detail!.content).toContain('npm install acme@4');
    expect(detail!.content).not.toContain('navigation chrome');
    expect(detail!.chunks[0]!.locator).toMatchObject({ url: 'https://blog.example.org/notes' });
    // A page is fetched by us: its receipts are the transfer and the embedding.
    const [run] = await expectChargedAtLeastCost(id);
    expect(run).toMatchObject({ status: 'ready', receipts: 2 });
    const [transfer] = (await db().select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.knowledgeId, id)))[0]!.charges.filter((charge) => charge.service === 'bandwidth');
    expect(transfer).toMatchObject({ model: 'fetch', basis: 'configured_rate' });
    expect(transfer!.usage.bytes).toBeGreaterThan(PAGE.length - 1);
    // Plus the example questions suggested after the first source (P2).
    const suggestions = await db().select().from(schema.knowledgeCostRun).where(and(eq(schema.knowledgeCostRun.reeId, ree.id), eq(schema.knowledgeCostRun.kind, 'suggestions')));
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - run!.charged - suggestions.reduce((sum, entry) => sum + (entry.chargedCredits ?? 0), 0));
  });

  it('refuses local and private addresses', async () => {
    const { userId, ree } = await userWithRee();
    for (const url of ['http://localhost:3000/x', 'http://169.254.169.254/latest', 'http://10.0.0.8/', 'ftp://example.org/a']) {
      expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'page', url }))).toBe('invalid_url');
    }
  });

  it('refuses a website until its domain is verified, then crawls sitemap and links', async () => {
    web.routes.set('docs.example.com/robots.txt', () => text('User-agent: *\nSitemap: https://docs.example.com/sitemap.xml'));
    web.routes.set('docs.example.com/sitemap.xml', () =>
      text('<?xml version="1.0"?><urlset><url><loc>https://docs.example.com/guide/install</loc></url><url><loc>https://other.example.com/x</loc></url></urlset>', 'application/xml'),
    );
    web.routes.set('docs.example.com/guide', () => html(sitePage('Guide', 'Start with the install page.', ['/guide/install', '/guide/limits', '/blog/unrelated', 'https://elsewhere.example.org/'])));
    web.routes.set('docs.example.com/guide/install', () => html(sitePage('Install', 'Run the installer as an administrator.')));
    web.routes.set('docs.example.com/guide/limits', () => html(sitePage('Limits', 'Each workspace holds 500 seats.', ['/guide/install#top'])));
    web.routes.set('docs.example.com/blog/unrelated', () => html(sitePage('Blog', 'Out of scope.')));

    const { userId, ree } = await userWithRee();
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'site', url: 'https://docs.example.com/guide' }))).toBe('domain_unverified');

    /* Verified by DNS TXT on the parent domain: subdomains are covered. */
    const claim = await connections.addDomain(userId, 'https://Example.com/path');
    expect(claim).toMatchObject({ domain: 'example.com', status: 'pending' });
    expect(claim.challenge).toMatch(/^re0-verification=[0-9a-f]{32}$/);
    const failed = await connections.verifyDomain(userId, claim.id, 'dns_txt', { dns: async () => 'not_found', wellKnown: async () => 'unreachable' });
    expect(failed.outcome).toBe('unreachable');
    expect(failed.domain.status).toBe('failed');
    const seen: string[] = [];
    const verified = await connections.verifyDomain(userId, claim.id, 'dns_txt', {
      dns: async (domain, challenge) => {
        seen.push(`${domain}:${challenge === claim.challenge}`);
        return 'matched';
      },
      wellKnown: async () => 'not_found',
    });
    expect(seen).toEqual(['example.com:true']);
    expect(verified.domain).toMatchObject({ status: 'verified', method: 'dns_txt' });

    const before = await balanceOf(db(), userId);
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'site', url: 'https://docs.example.com/guide' });
    expect(await balanceOf(db(), userId)).toBe(before - 1);
    await knowledge.processKnowledge(id, { profile: false });
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail?.status).toBe('ready');
    expect(detail!.children.map((child) => child.url).sort()).toEqual([
      'https://docs.example.com/guide',
      'https://docs.example.com/guide/install',
      'https://docs.example.com/guide/limits',
    ]);
    expect(detail!.content).toBeNull();
    const limits = detail!.children.findIndex((child) => child.label === 'Limits');
    expect((await knowledge.knowledgeChild(ree.id, id, limits))?.content).toContain('500 seats');
    const settled = 1;
    expect(await balanceOf(db(), userId)).toBe(before - settled);
    expect(await expectChargedAtLeastCost(id)).toEqual([expect.objectContaining({ status: 'ready', charged: settled })]);
  });

  it('verifies by the well-known file when DNS has nothing', async () => {
    const { userId } = await userWithRee();
    const claim = await connections.addDomain(userId, 'example.net');
    web.routes.set('example.net/.well-known/re0-verification.txt', () => text(`${claim.challenge}\n`));
    expect(await checkWellKnownChallenge('example.net', claim.challenge)).toBe('matched');
    expect(await checkWellKnownChallenge('example.net', 're0-verification=wrong')).toBe('not_found');
    const result = await connections.verifyDomain(userId, claim.id, 'dns_txt', {
      dns: async () => 'not_found',
      wellKnown: (domain, challenge) => checkWellKnownChallenge(domain, challenge),
    });
    expect(result).toMatchObject({ outcome: 'verified', domain: { method: 'well_known', status: 'verified' } });
    expect(await connections.hasVerifiedDomainFor(userId, 'docs.example.net')).toBe(true);
    expect(await connections.hasVerifiedDomainFor(userId, 'example.network')).toBe(false);
    /* A verified domain is not added twice; removing it closes new crawls again. */
    expect(await refusal(connections.addDomain(userId, 'example.net'))).toBe('domain_exists');
    expect(await connections.removeDomain(userId, claim.id)).toBe(true);
    expect(await connections.hasVerifiedDomainFor(userId, 'example.net')).toBe(false);
  });
});

/* ------------------------------------------------------------------- audio */

describeWithDb('audio', () => {
  it('transcribes 100 MB in pieces and cites "第 6:17"', async () => {
    const size = 100 * 1024 * 1024;
    const { userId, ree } = await userWithRee(20_000);
    const path = `knowledge/${userId}/a/interview.mp3`;
    blobs.set(path, fakeMp3(size));
    fake.transcripts.clear();
    const calls = fake.requests.filter((request) => request.path.endsWith('/audio/transcriptions')).length;
    fake.transcripts.set('0:1', 'The lighthouse keeper records the tide tables at dawn.');
    fake.transcripts.set('1:1', 'The ferry timetable changes every winter.');

    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'audio', blobPath: path, fileName: 'interview.mp3', consent: false }))).toBe('consent_required');
    const before = await balanceOf(db(), userId);
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'audio', blobPath: path, fileName: 'interview.mp3', consent: true });
    /* Initial balance check is refundable; duration does not quote the final cost. */
    expect(await balanceOf(db(), userId)).toBe(before - 1);

    await knowledge.processKnowledge(id, { profile: false });
    const transcriptions = fake.requests.filter((request) => request.path.endsWith('/audio/transcriptions'));
    /* Ten-minute pieces: 100 MB at 128 kbps is eleven calls, none near the call's 120 s. */
    expect(transcriptions.length - calls).toBe(Math.ceil(size / (FAKE_MP3_PIECE_FRAMES * 417)));
    expect(transcriptions.at(-1)?.model).toBe('fake-whisper');

    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail?.status).toBe('ready');
    const lighthouse = detail!.children.find((child) => (detail!.content ?? '').slice(child.offset, child.offset + child.length).includes('lighthouse'));
    expect(lighthouse?.time).toBe(377);
    /* The second piece starts where the first piece's frames end, not where the endpoint says it did. */
    const firstPiece = FAKE_MP3_PIECE_FRAMES * FAKE_MP3_FRAME_SECONDS;
    const ferry = detail!.children.find((child) => (detail!.content ?? '').slice(child.offset, child.offset + child.length).includes('ferry'));
    expect(ferry!.time!).toBeGreaterThan(firstPiece + 376);
    expect(ferry!.time!).toBeLessThan(firstPiece + 378);

    const retrieval = await chat.retrieve(ree.id, 'When does the lighthouse keeper record the tide tables?');
    expect(retrieval.passages[0]?.locator.time).toBe(377);
    expect(locatorLabel(retrieval.passages[0]!.locator, 'zh')).toBe('第 6:17');
    expect(locatorLabel(retrieval.passages[0]!.locator, 'en')).toBe('6:17');
    expect(retrieval.passages.some((passage) => passage.locator.overview)).toBe(false);

    /* A question about the sources themselves also sees the recording whole: its length, beginning and end. */
    const library = await chat.retrieve(ree.id, 'List every recording and how each one ends.');
    expect(library.evidence).toBe(true);
    expect(library.passages[0]).toMatchObject({ knowledgeId: id, locator: { overview: true } });
    expect(library.passages[0]!.content).toMatch(/^Overview of this whole source: audio recording, 1:49:\d\d long/);
    /* The fake transcript is short, so the overview carries all of it. */
    expect(library.passages[0]!.content).toContain('Full text: Part 0-0 of the recording');
    expect(library.passages[0]!.content).toContain('The lighthouse keeper records the tide tables at dawn.');
    expect(library.passages.filter((passage) => !passage.locator.overview).length).toBeGreaterThan(0);

    /* Sum each transcription piece’s provider cost and the embedding cost, then round once. */
    const charges = detail!.activity.filter((entry) => entry.code === 'provider_usage').map((entry) => JSON.parse(String(entry.detail!.charge)));
    const price = Math.ceil(charges.reduce((sum, charge) => sum + Number(charge.costUsd), 0) / 0.0001);
    expect(price).toBeGreaterThan(6_500);
    expect(await balanceOf(db(), userId)).toBe(before - price);
    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, id)).orderBy(asc(schema.creditEntry.createdAt));
    expect(entries[0]).toMatchObject({ reason: 'knowledge_hold', delta: -1 });
    expect(entries.at(-1)).toMatchObject({ reason: 'knowledge_settle' });
    expect(entries.reduce((sum, entry) => sum + entry.delta, 0)).toBe(-price);
    // Every piece's own length was reserved before it was sent, and each receipt bills at least that length.
    expect(detail!.activity.some((entry) => entry.code === 'reserved' && entry.detail?.estimate === 1)).toBe(true);
    for (const charge of charges.filter((entry) => entry.service === 'transcription')) expect(charge.usage.seconds).toBeGreaterThan(0);
    expect(await expectChargedAtLeastCost(id)).toEqual([expect.objectContaining({ status: 'ready', charged: price })]);
  }, 60_000);
});
