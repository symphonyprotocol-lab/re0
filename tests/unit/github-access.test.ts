/**
 * Which token reads a repository (`resolveRepository`): the owner's when it
 * sees the repository, otherwise -- public repositories only -- the server's
 * read token or none; refusals never say whether a private repository exists.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRepository, serverReadToken, type RepositoryInfo } from '@/lib/infra/connectors/github';
import { ProcessingFailure } from '@/lib/infra/connectors/failure';

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
    expect(await resolveRepository(REF, null, { serverToken: null, read })).toEqual({ ok: true, repository: PUBLIC, token: null, via: 'public' });
    expect(asked).toEqual([null]);
  });

  it('prefers the server read token over anonymous reads', async () => {
    const { read, asked } = github({ server: PUBLIC, anonymous: PUBLIC });
    expect(await resolveRepository(REF, null, { serverToken: 'server', read })).toMatchObject({ ok: true, token: 'server', via: 'public' });
    expect(asked).toEqual(['server']);
  });

  it('falls back to anonymous when the server token is refused', async () => {
    const { read, asked } = github({ server: revoked(), anonymous: PUBLIC });
    expect(await resolveRepository(REF, null, { serverToken: 'server', read })).toMatchObject({ ok: true, token: null, via: 'public' });
    expect(asked).toEqual(['server', null]);
  });

  it('says not connected, not "private", for a private or missing repository without a connection', async () => {
    expect(await resolveRepository(REF, null, { serverToken: null, read: github({}).read })).toEqual({ ok: false, reason: 'not_connected' });
    /* The server token can see this private repository: it must not be used on the owner's behalf. */
    const { read } = github({ server: PRIVATE });
    expect(await resolveRepository(REF, null, { serverToken: 'server', read })).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('uses the owner token for anything it can see, private included', async () => {
    const { read, asked } = github({ owner: PRIVATE });
    expect(await resolveRepository(REF, 'owner', { serverToken: 'server', read })).toEqual({ ok: true, repository: PRIVATE, token: 'owner', via: 'owner' });
    expect(asked).toEqual(['owner']);
  });

  it('falls back to public reads when the owner token cannot see a public repository', async () => {
    const { read, asked } = github({ owner: null, anonymous: PUBLIC });
    expect(await resolveRepository(REF, 'owner', { serverToken: null, read })).toMatchObject({ ok: true, token: null, via: 'public' });
    expect(asked).toEqual(['owner', null]);
  });

  it('keeps "not found" for a connected owner and "not connected" for a revoked token', async () => {
    expect(await resolveRepository(REF, 'owner', { serverToken: null, read: github({ owner: null }).read })).toEqual({ ok: false, reason: 'not_found' });
    expect(await resolveRepository(REF, 'owner', { serverToken: null, read: github({ owner: revoked() }).read })).toEqual({ ok: false, reason: 'not_connected' });
    /* A revoked owner token still lets a public repository through. */
    expect(await resolveRepository(REF, 'owner', { serverToken: null, read: github({ owner: revoked(), anonymous: PUBLIC }).read })).toMatchObject({ ok: true, via: 'public' });
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
