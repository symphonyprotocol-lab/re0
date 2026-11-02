/**
 * Acceptance (8.4 step 2), the four kinds that reach outside:
 *   - a public repository is added from its URL alone; a private one is
 *     refused until the owner connects GitHub, then read with their token
 *     and cited by file and line;
 *   - a single page needs no claim; a website is refused until its domain is
 *     verified, by DNS TXT or by the well-known file, either one;
 *   - a 100 MB audio file is cut into pieces, transcribed with timestamps
 *     stitched across them, and a passage starting at 754 s cites "第 12:34".
 * GitHub, the sites and DNS are stubbed; transcription and embeddings go to
 * the local fake endpoint.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { asc, eq } from 'drizzle-orm';
import { FAKE_AUDIO_BYTES_PER_SECOND, fakeMp3, startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { authorization, html, jsonResponse, startFakeWeb, text, type FakeWeb } from '../fixtures/fake-web';

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

function serveRepository(owner: string, name: string, visibility: 'public' | 'private') {
  const repo = `api.github.com/repos/${owner}/${name}`;
  const allowed = (init: RequestInit | undefined) => visibility === 'public' || authorization(init) === 'Bearer gho_secret_token';
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
  web.routes.set(`raw.githubusercontent.com/${owner}/${name}/abc1234def/README.md`, (_url, init) => (allowed(init) ? text(README) : text('', 'text/plain')));
  web.routes.set(`raw.githubusercontent.com/${owner}/${name}/abc1234def/src/greet.ts`, (_url, init) => (allowed(init) ? text(SOURCE) : text('', 'text/plain')));
}

describeWithDb('GitHub repositories', () => {
  it('adds a public repository from its URL and cites file and line', async () => {
    serveRepository('acme', 'handbook', 'public');
    const { userId, ree } = await userWithRee();
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'https://github.com/acme/handbook/tree/main/docs' });
    expect(await balanceOf(db(), userId)).toBe(2000 - 120);
    await knowledge.processKnowledge(id);
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail).toMatchObject({ status: 'ready', title: 'acme/handbook', source: 'https://github.com/acme/handbook' });
    expect(detail!.children.map((child) => child.path)).toEqual(['README.md', 'src/greet.ts']);
    const deploys = detail!.chunks.find((chunk) => chunk.content.includes('Tuesday'));
    expect(deploys?.locator).toMatchObject({ path: 'README.md', line: 5, heading: 'Acme handbook › Deploys' });
    expect(locatorLabel(deploys!.locator, 'zh')).toContain('README.md:5');
    const file = await knowledge.knowledgeChild(ree.id, id, 1);
    expect(file?.content).toBe(SOURCE.trimEnd());
  });

  it('refuses a private repository until GitHub is connected, then reads it with the token', async () => {
    serveRepository('acme', 'secret', 'private');
    const { userId, ree } = await userWithRee();
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'https://github.com/acme/secret' }))).toBe('github_not_connected');
    expect(await balanceOf(db(), userId)).toBe(2000);

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

  it('does not mistake an exhausted anonymous rate limit for a private repository', async () => {
    serveRepository('acme', 'busy', 'public');
    /* GitHub's answer once the shared anonymous limit is used up; a token has its own. */
    const limited = (handler: (url: URL, init: RequestInit | undefined) => Response) => (url: URL, init: RequestInit | undefined) =>
      authorization(init) ? handler(url, init) : new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    web.routes.set('api.github.com/repos/acme/busy', limited(() => jsonResponse({ full_name: 'acme/busy', private: false, default_branch: 'main' })));
    const { userId, ree } = await userWithRee();
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'acme/busy' }))).toBe('source_unreachable');

    await connections.saveGithubConnection(userId, { accessToken: 'gho_secret_token', login: 'acme-dev', scope: 'repo' });
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'acme/busy' });
    await knowledge.processKnowledge(id);
    expect((await knowledge.knowledgeDetail(ree.id, id))?.status).toBe('ready');
  });

  it('says not found for a repository the connected account cannot read', async () => {
    const { userId, ree } = await userWithRee();
    await connections.saveGithubConnection(userId, { accessToken: 'gho_other', login: 'someone', scope: 'repo' });
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'https://github.com/acme/secret' }))).toBe('github_repo_not_found');
    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'github', url: 'https://gitlab.com/acme/secret' }))).toBe('invalid_github_url');
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
    expect(await balanceOf(db(), userId)).toBe(before - 500);
    await knowledge.processKnowledge(id);
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
    const settled = Math.ceil((await knowledge.knowledgeText(ree.id, id))!.content.length / 1000);
    expect(await balanceOf(db(), userId)).toBe(before - settled);
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
  it('transcribes 100 MB in pieces and cites "第 12:34"', async () => {
    const size = 100 * 1024 * 1024;
    const { userId, ree } = await userWithRee(20_000);
    const path = `knowledge/${userId}/a/interview.mp3`;
    blobs.set(path, fakeMp3(size));
    fake.transcripts.clear();
    const calls = fake.requests.filter((request) => request.path.endsWith('/audio/transcriptions')).length;
    fake.transcripts.set('0:2', 'The lighthouse keeper records the tide tables at dawn.');
    fake.transcripts.set('1:1', 'The ferry timetable changes every winter.');

    expect(await refusal(knowledge.addKnowledge(userId, ree, { kind: 'audio', blobPath: path, fileName: 'interview.mp3', consent: false }))).toBe('consent_required');
    const before = await balanceOf(db(), userId);
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'audio', blobPath: path, fileName: 'interview.mp3', consent: true });
    /* The hold: 100 MB ≈ 100 minutes × 100 credits, plus their estimated transcript. */
    expect(await balanceOf(db(), userId)).toBe(before - 10_100);

    await knowledge.processKnowledge(id);
    const transcriptions = fake.requests.filter((request) => request.path.endsWith('/audio/transcriptions'));
    expect(transcriptions.length - calls).toBe(5);
    expect(transcriptions.at(-1)?.model).toBe('fake-whisper');

    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail?.status).toBe('ready');
    const lighthouse = detail!.children.find((child) => (detail!.content ?? '').slice(child.offset, child.offset + child.length).includes('lighthouse'));
    expect(lighthouse?.time).toBe(754);
    const firstPiece = Math.ceil((24 * 1024 * 1024 - 4096) / 417) * 417;
    const ferry = detail!.children.find((child) => (detail!.content ?? '').slice(child.offset, child.offset + child.length).includes('ferry'));
    expect(ferry!.time!).toBeGreaterThan(firstPiece / FAKE_AUDIO_BYTES_PER_SECOND + 376);
    expect(ferry!.time!).toBeLessThan(firstPiece / FAKE_AUDIO_BYTES_PER_SECOND + 378);

    const retrieval = await chat.retrieve(ree.id, 'When does the lighthouse keeper record the tide tables?');
    expect(retrieval.passages[0]?.locator.time).toBe(754);
    expect(locatorLabel(retrieval.passages[0]!.locator, 'zh')).toBe('第 12:34');
    expect(locatorLabel(retrieval.passages[0]!.locator, 'en')).toBe('12:34');

    /* About 109 minutes: more than the hold, and a shortfall is not charged (多退少不补). */
    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, id)).orderBy(asc(schema.creditEntry.createdAt));
    expect(entries.map((entry) => [entry.reason, entry.delta])).toEqual([
      ['knowledge_hold', -10_100],
      ['knowledge_settle', 0],
    ]);
  }, 60_000);
});
