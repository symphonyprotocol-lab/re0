/**
 * Which token reads a repository (`resolveRepository`): the owner's when it
 * sees the repository, otherwise -- public repositories only -- the server's
 * read token or none; refusals never say whether a private repository exists.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fetchRepositoryFiles, readRepository, resolveRepository, retryDelay, serverReadToken, type RepositoryInfo } from '@/lib/infra/connectors/github';
import { ProcessingFailure } from '@/lib/infra/connectors/failure';
import { retryAfterMs } from '@/lib/infra/connectors/http';
import { jsonResponse, startFakeWeb, text, type FakeWeb } from '../fixtures/fake-web';

const REF = { owner: 'acme', name: 'docs' };
const PUBLIC: RepositoryInfo = { fullName: 'acme/docs', private: false, defaultBranch: 'main' };
const PRIVATE: RepositoryInfo = { ...PUBLIC, private: true };

type Seen = RepositoryInfo | null | ProcessingFailure;

/** GitHub as each token (null: anonymous) sees the repository; records who asked. */
function github(views: Record<string, Seen>) {
  const asked: (string | null)[] = [];
  const read = async (_ref: unknown, token: string | null) => {
    asked.push(token);
    const view = views[token ?? 'anonymous'] ?? null;
    if (view instanceof ProcessingFailure) throw view;
    return view;
  };
  return { read, asked };
}

const revoked = () => new ProcessingFailure('source_forbidden', 'bad credentials', 401);

describe('GitHub repository access', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads a public repository anonymously when the owner has no connection', async () => {
    const { read, asked } = github({ anonymous: PUBLIC });
    expect(await resolveRepository(REF, null, { serverToken: null, read })).toEqual({ ok: true, repository: PUBLIC, token: null });
    expect(asked).toEqual([null]);
  });

  it('prefers the server read token over anonymous reads', async () => {
    const { read, asked } = github({ server: PUBLIC, anonymous: PUBLIC });
    expect(await resolveRepository(REF, null, { serverToken: 'server', read })).toMatchObject({ ok: true, token: 'server' });
    expect(asked).toEqual(['server']);
  });

  it('falls back to anonymous when the server token is refused', async () => {
    const { read, asked } = github({ server: revoked(), anonymous: PUBLIC });
    expect(await resolveRepository(REF, null, { serverToken: 'server', read })).toMatchObject({ ok: true, token: null });
    expect(asked).toEqual(['server', null]);
  });

  it('spends no anonymous call when the server token finds nothing', async () => {
    const { read, asked } = github({ server: null, anonymous: PUBLIC });
    expect(await resolveRepository(REF, null, { serverToken: 'server', read })).toEqual({ ok: false, reason: 'not_connected' });
    expect(asked).toEqual(['server']);
  });

  it('says not connected, not "private", for a private or missing repository without a connection', async () => {
    expect(await resolveRepository(REF, null, { serverToken: null, read: github({}).read })).toEqual({ ok: false, reason: 'not_connected' });
    /* The server token can see this private repository: it must not be used on the owner's behalf. */
    const { read } = github({ server: PRIVATE });
    expect(await resolveRepository(REF, null, { serverToken: 'server', read })).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('uses the owner token for anything it can see, private included', async () => {
    const { read, asked } = github({ owner: PRIVATE });
    expect(await resolveRepository(REF, 'owner', { serverToken: 'server', read })).toEqual({ ok: true, repository: PRIVATE, token: 'owner' });
    expect(asked).toEqual(['owner']);
  });

  it('falls back to public reads when the owner token cannot see a public repository', async () => {
    const { read, asked } = github({ owner: null, anonymous: PUBLIC });
    expect(await resolveRepository(REF, 'owner', { serverToken: null, read })).toMatchObject({ ok: true, token: null });
    expect(asked).toEqual(['owner', null]);
  });

  it('keeps "not found" for a connected owner and "not connected" for a revoked token', async () => {
    expect(await resolveRepository(REF, 'owner', { serverToken: null, read: github({ owner: null }).read })).toEqual({ ok: false, reason: 'not_found' });
    expect(await resolveRepository(REF, 'owner', { serverToken: null, read: github({ owner: revoked() }).read })).toEqual({ ok: false, reason: 'not_connected' });
    /* A revoked owner token still lets a public repository through. */
    expect(await resolveRepository(REF, 'owner', { serverToken: null, read: github({ owner: revoked(), anonymous: PUBLIC }).read })).toMatchObject({ ok: true, token: null });
  });

  it('lets a rate limit or outage through rather than calling it missing', async () => {
    const busy = new ProcessingFailure('rate_limited', 'API rate limit exceeded');
    await expect(resolveRepository(REF, null, { serverToken: null, read: github({ anonymous: busy }).read })).rejects.toBe(busy);
    await expect(resolveRepository(REF, 'owner', { serverToken: null, read: github({ owner: busy }).read })).rejects.toBe(busy);
  });

  it('reads the optional server token from GITHUB_READ_TOKEN', () => {
    vi.stubEnv('GITHUB_READ_TOKEN', '');
    expect(serverReadToken()).toBeNull();
    vi.stubEnv('GITHUB_READ_TOKEN', '  github_pat_x \n');
    expect(serverReadToken()).toBe('github_pat_x');
  });
});

describe('GitHub throttling', () => {
  let web: FakeWeb;
  beforeAll(() => {
    web = startFakeWeb(['api.github.com', 'raw.githubusercontent.com']);
  });
  afterAll(() => web.restore());
  afterEach(() => web.routes.clear());

  it('reads retry-after (seconds or a date) and the primary limit reset', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    expect(retryAfterMs(new Headers({ 'retry-after': '7' }), now)).toBe(7000);
    expect(retryAfterMs(new Headers({ 'retry-after': 'Wed, 11 Nov 2026 12:00:30 GMT' }), now)).toBe(30_000);
    expect(retryAfterMs(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 90) }), now)).toBe(90_000);
    expect(retryAfterMs(new Headers({ 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '1' }), now)).toBeUndefined();
  });

  it('treats a secondary rate limit as rate_limited, not as a hidden repository', async () => {
    web.routes.set('api.github.com/repos/acme/docs', () =>
      new Response('{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}', { status: 403, headers: { 'x-ratelimit-remaining': '41' } }),
    );
    await expect(readRepository(REF, null)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(resolveRepository(REF, null, { serverToken: null })).rejects.toMatchObject({ code: 'rate_limited' });

    web.routes.set('api.github.com/repos/acme/docs', () => new Response('', { status: 403, headers: { 'retry-after': '60' } }));
    await expect(readRepository(REF, null)).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: 60_000 });

    /* A plain 403 still hides the repository like a 404. */
    web.routes.set('api.github.com/repos/acme/docs', () => jsonResponse({ message: 'Resource not accessible' }, 403));
    expect(await readRepository(REF, null)).toBeNull();
  });

  it('gives up retrying on a long wait or after three attempts, and only for throttled or unanswered reads', () => {
    const busy = (ms?: number) => new ProcessingFailure('rate_limited', 'busy', 429, ms);
    expect(retryDelay(busy(2000), 0)).toBe(2000);
    expect(retryDelay(busy(), 1)).toBe(2000);
    expect(retryDelay(busy(60_000), 0)).toBeNull();
    expect(retryDelay(busy(), 3)).toBeNull();
    expect(retryDelay(new ProcessingFailure('source_unreachable', 'down'), 0)).toBe(1000);
    expect(retryDelay(new ProcessingFailure('source_missing', 'gone'), 0)).toBeNull();
  });

  function serveTree(paths: string[]) {
    web.routes.set('api.github.com/repos/acme/docs', () => jsonResponse({ full_name: 'acme/docs', private: false, default_branch: 'main' }));
    web.routes.set('api.github.com/repos/acme/docs/branches/main', () => jsonResponse({ commit: { sha: 'abc123' } }));
    web.routes.set('api.github.com/repos/acme/docs/git/trees/abc123', () => jsonResponse({ tree: paths.map((path) => ({ path, type: 'blob', size: 10 })) }));
  }

  it('retries a throttled file read, skips a missing one and counts one that never answers', async () => {
    serveTree(['a.md', 'b.md', 'c.md', 'd.md']);
    let throttledTimes = 0;
    web.routes.set('raw.githubusercontent.com/acme/docs/abc123/a.md', () => text('# A'));
    web.routes.set('raw.githubusercontent.com/acme/docs/abc123/b.md', () =>
      ++throttledTimes <= 2 ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : text('# B'),
    );
    web.routes.set('raw.githubusercontent.com/acme/docs/abc123/c.md', () => new Response('', { status: 404 }));
    web.routes.set('raw.githubusercontent.com/acme/docs/abc123/d.md', () => new Response('', { status: 502 }));
    const waits: number[] = [];
    const snapshot = await fetchRepositoryFiles(REF, null, { serverToken: null, sleep: async (ms) => void waits.push(ms) });
    expect(snapshot.files.map((file) => file.path)).toEqual(['a.md', 'b.md']);
    expect(snapshot).toMatchObject({ truncated: true, unread: 1 });
    expect(waits.filter((ms) => ms === 1000)).toHaveLength(2 + 1);
    expect(waits).toContain(2000);
    expect(waits).toContain(4000);
  });

  it('fails the import as rate_limited when GitHub keeps throttling, rather than keep a subset', async () => {
    serveTree(['a.md', 'b.md']);
    web.routes.set('raw.githubusercontent.com/acme/docs/abc123/a.md', () => text('# A'));
    web.routes.set('raw.githubusercontent.com/acme/docs/abc123/b.md', () => new Response('', { status: 429, headers: { 'retry-after': '1' } }));
    const sleep = vi.fn(async () => undefined);
    await expect(fetchRepositoryFiles(REF, null, { serverToken: null, sleep })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
