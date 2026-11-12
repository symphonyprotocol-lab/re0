/**
 * Importing part of a repository: `/tree/<ref>` and `/tree/<ref>/<path>`
 * URLs (refs with slashes settled against the repository's refs), what a
 * whole-repository import leaves out as noise, and the connector reading
 * only that ref and directory.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseGithubRepo, repositoryTitle, repositoryUrl, settleTreeRef } from '@/lib/domain/sources';
import { fetchRepositoryFiles, olderVersionPaths, selectPaths, selectRepositoryPaths, versionOf } from '@/lib/infra/connectors/github';
import { jsonResponse, startFakeWeb, text, type FakeWeb } from '../fixtures/fake-web';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';

describe('repository URLs with a ref and a folder', () => {
  it('keeps a plain repository URL as the whole default branch', () => {
    expect(parseGithubRepo('https://github.com/vitejs/vite')).toEqual({ owner: 'vitejs', name: 'vite' });
    expect(parseGithubRepo('https://github.com/vitejs/vite/')).toEqual({ owner: 'vitejs', name: 'vite' });
    expect(parseGithubRepo('https://github.com/vitejs/vite/tree')).toEqual({ owner: 'vitejs', name: 'vite' });
    expect(parseGithubRepo('https://github.com/vitejs/vite/pulls')).toEqual({ owner: 'vitejs', name: 'vite' });
  });

  it('reads a branch, and a folder on a branch', () => {
    expect(parseGithubRepo('https://github.com/vercel/ai/tree/v5')).toEqual({ owner: 'vercel', name: 'ai', ref: 'v5' });
    expect(parseGithubRepo('https://github.com/vitejs/vite/tree/main/docs/')).toEqual({ owner: 'vitejs', name: 'vite', ref: 'main', path: 'docs', refUnsettled: true });
    expect(parseGithubRepo('https://github.com/vercel/ai/tree/main/content/docs')).toMatchObject({ ref: 'main', path: 'content/docs' });
    /* `blob` URLs name one file the same way. */
    expect(parseGithubRepo('https://github.com/acme/handbook/blob/main/guide/setup.md')).toMatchObject({ ref: 'main', path: 'guide/setup.md' });
    /* A query or fragment is not part of the path. */
    expect(parseGithubRepo('https://github.com/acme/handbook/tree/main/docs?plain=1#readme')).toMatchObject({ ref: 'main', path: 'docs' });
  });

  it('reads a commit SHA or an encoded slash in the ref as settled', () => {
    expect(parseGithubRepo(`https://github.com/acme/handbook/tree/${SHA}/docs`)).toEqual({ owner: 'acme', name: 'handbook', ref: SHA, path: 'docs' });
    expect(parseGithubRepo('https://github.com/acme/handbook/tree/release%2F2.x/docs')).toEqual({ owner: 'acme', name: 'handbook', ref: 'release/2.x', path: 'docs' });
    expect(parseGithubRepo('https://github.com/acme/handbook/tree/release%2f2.x')).toEqual({ owner: 'acme', name: 'handbook', ref: 'release/2.x' });
  });

  it('refuses refs and paths that are not names', () => {
    /* URL parsing resolves `..` in the path (encoded or not) before it gets here; inside an encoded ref it is refused. */
    expect(parseGithubRepo('https://github.com/acme/handbook/tree/main/%2e%2e/x')).toMatchObject({ ref: 'x' });
    expect(parseGithubRepo('https://github.com/acme/handbook/tree/a%2F..%2Fb/docs')).toBeNull();
    expect(parseGithubRepo('https://github.com/acme/handbook/tree/main/a%2Fb')).toBeNull();
    expect(parseGithubRepo('https://github.com/acme/handbook/tree/%E0%A4%A')).toBeNull();
    expect(parseGithubRepo('https://github.com/acme/handbook/tree/ma%00in')).toBeNull();
  });

  it('settles a ref with slashes against the branches and tags that exist', () => {
    const parsed = parseGithubRepo('https://github.com/acme/handbook/tree/feature/new-docs/docs/guide')!;
    expect(parsed).toMatchObject({ ref: 'feature', path: 'new-docs/docs/guide', refUnsettled: true });
    expect(settleTreeRef(parsed, ['feature/new-docs', 'feature/other', 'main'])).toEqual({ owner: 'acme', name: 'handbook', ref: 'feature/new-docs', path: 'docs/guide' });
    /* The longest match wins: `feature/new-docs/docs` is a branch too. */
    expect(settleTreeRef(parsed, ['feature/new-docs', 'feature/new-docs/docs'])).toMatchObject({ ref: 'feature/new-docs/docs', path: 'guide' });
    /* A whole run of segments can be the ref, leaving no folder. */
    expect(settleTreeRef(parsed, ['feature/new-docs/docs/guide'])).toEqual({ owner: 'acme', name: 'handbook', ref: 'feature/new-docs/docs/guide' });
    /* No match: the first segment, as GitHub's own pages do. */
    expect(settleTreeRef(parsed, ['main'])).toEqual({ owner: 'acme', name: 'handbook', ref: 'feature', path: 'new-docs/docs/guide' });
    /* A settled ref is left alone. */
    const settled = parseGithubRepo('https://github.com/acme/handbook/tree/release%2F2.x/docs')!;
    expect(settleTreeRef(settled, ['release'])).toBe(settled);
  });

  it('writes the stored URL so that reading it back names the same ref and folder', () => {
    const cases = [
      { owner: 'acme', name: 'handbook' },
      { owner: 'acme', name: 'handbook', ref: 'v2' },
      { owner: 'acme', name: 'handbook', ref: 'release/2.x', path: 'docs/guide' },
      { owner: 'acme', name: 'handbook', ref: SHA, path: 'docs' },
    ];
    for (const ref of cases) expect(parseGithubRepo(repositoryUrl(ref))).toEqual(ref);
    expect(repositoryUrl({ owner: 'acme', name: 'handbook', ref: 'release/2.x', path: 'docs/my guide' })).toBe('https://github.com/acme/handbook/tree/release%2F2.x/docs/my%20guide');
    /* A plain ref with a folder reads back unsettled: it is settled against GitHub again, to the same split. */
    const plain = parseGithubRepo(repositoryUrl({ owner: 'acme', name: 'handbook', ref: 'main', path: 'docs' }))!;
    expect(settleTreeRef(plain, ['main'])).toEqual({ owner: 'acme', name: 'handbook', ref: 'main', path: 'docs' });
  });

  it('titles a source by repository, folder and ref', () => {
    expect(repositoryTitle('vitejs/vite', {})).toBe('vitejs/vite');
    expect(repositoryTitle('vitejs/vite', { ref: 'main', path: 'docs' })).toBe('vitejs/vite/docs @ main');
    expect(repositoryTitle('vercel/ai', { ref: 'v5' })).toBe('vercel/ai @ v5');
  });
});

describe('what a repository import reads', () => {
  const entries = (paths: string[]) => paths.map((path) => ({ path, size: 10 }));

  it('leaves out changelogs, changesets, CI files and tests, but keeps source', () => {
    const paths = selectPaths(entries([
      'README.md',
      'CHANGELOG.md',
      'packages/ai/CHANGELOG.md',
      'packages/ai/CHANGELOG-v4.md',
      'HISTORY.md',
      '.changeset/brave-cats.md',
      '.github/workflows/ci.yml',
      '.github/ISSUE_TEMPLATE/bug.md',
      'packages/ai/src/generate-text.ts',
      'packages/ai/src/generate-text.test.ts',
      'packages/ai/src/stream-text.spec.tsx',
      'packages/ai/src/__snapshots__/x.ts',
      'packages/ai/tests/e2e.ts',
      'packages/ai/test/helpers.ts',
      'packages/ai/__tests__/x.ts',
      'playground/fixtures/basic.ts',
      'py/test_client.py',
      'go/client_test.go',
      'go/client.go',
      'docs/guide/env.md',
      'docs/guide/testing.md',
    ]));
    expect(paths).toEqual(['README.md', 'docs/guide/env.md', 'docs/guide/testing.md', 'go/client.go', 'packages/ai/src/generate-text.ts']);
  });

  it('keeps only the newest copy of versioned docs, and their unversioned siblings', () => {
    const spec = (version: string, extra: string[] = []) => ['index.mdx', 'basic/lifecycle.mdx', 'server/tools.mdx', ...extra].map((file) => `docs/specification/${version}/${file}`);
    const { paths, olderVersions } = selectRepositoryPaths(entries([
      ...spec('2024-11-05'),
      ...spec('2025-03-26'),
      ...spec('2025-06-18', ['server/elicitation.mdx']),
      'docs/specification/draft/index.mdx',
      'website/versioned_docs/version-2.x/intro.md',
      'website/docs/intro.md',
      ...['client.ts', 'types.ts', 'errors.ts'].flatMap((file) => [`api/v1/${file}`, `api/v2/${file}`]),
    ]));
    expect(paths).toEqual([
      'website/docs/intro.md',
      'docs/specification/2025-06-18/index.mdx',
      'docs/specification/draft/index.mdx',
      'docs/specification/2025-06-18/basic/lifecycle.mdx',
      'docs/specification/2025-06-18/server/elicitation.mdx',
      'docs/specification/2025-06-18/server/tools.mdx',
      'api/v2/client.ts',
      'api/v2/errors.ts',
      'api/v2/types.ts',
    ]);
    /* Two older specification copies of three files each, and api/v1: counted for the processing record. */
    expect(olderVersions).toBe(9);
  });

  it('keeps dated archives, release notes and numbered chapters that are not copies of each other', () => {
    const { paths, olderVersions } = selectRepositoryPaths(entries([
      'blog/2024-05/launch.md',
      'blog/2024-05/pricing.md',
      'blog/2024-05/roadmap.md',
      'blog/2024-06/agents.md',
      'blog/2024-06/memory.md',
      'blog/2024-06/search.md',
      'releases/2024-05/notes.md',
      'releases/2024-06/notes.md',
      'book/1.1/intro.md',
      'book/1.2/setup.md',
      'book/2.3/deploy.md',
    ]));
    expect(paths).toHaveLength(11);
    expect(olderVersions).toBe(0);
  });

  it('tells versions apart from chapters', () => {
    expect(versionOf('2025-06-18')).toEqual({ kind: 'date', parts: [2025, 6, 18] });
    expect(versionOf('2025-06')).toEqual({ kind: 'date', parts: [2025, 6] });
    expect(versionOf('v10')).toEqual({ kind: 'number', parts: [10] });
    expect(versionOf('version-2.1.0')).toEqual({ kind: 'number', parts: [2, 1, 0] });
    expect(versionOf('3.0')).toEqual({ kind: 'number', parts: [3, 0] });
    for (const name of ['1', '01-intro', 'draft', 'vision', 'v', 'latest']) expect(versionOf(name)).toBeNull();
    /* v10 is newer than v9; copies need a few files in common; a lone version has nothing to be older than. */
    const copy = (version: string) => ['a.md', 'b.md', 'c.md'].map((file) => `x/${version}/${file}`);
    expect([...olderVersionPaths([...copy('v9'), ...copy('v10'), 'y/v1/a.md'])]).toEqual(copy('v9'));
    expect([...olderVersionPaths(['x/v9/a.md', 'x/v10/a.md'])]).toEqual([]);
    /* Half the files in common is a copy; less is not. */
    expect(olderVersionPaths([...copy('v1'), 'x/v2/a.md', 'x/v2/b.md', 'x/v2/d.md']).size).toBe(3);
    expect(olderVersionPaths([...copy('v1'), 'x/v2/a.md', 'x/v2/e.md', 'x/v2/f.md']).size).toBe(0);
  });

  it('reads prose that lives in test folders, but not test code', () => {
    expect(selectPaths(entries([
      'docs/test/writing-tests.md',
      'docs/test/setup.ts',
      'packages/core/tests/README.md',
      'packages/core/tests/unit.ts',
      'e2e/guide.mdx',
      'fixtures/data.json',
    ]))).toEqual(['e2e/guide.mdx', 'docs/test/writing-tests.md', 'packages/core/tests/README.md']);
  });

  it('reads only the folder a URL names, applying the noise rules below it', () => {
    const all = entries([
      'README.md',
      'docs/guide/env.md',
      'docs/guide/CHANGELOG.md',
      'docs/guide/env.test.ts',
      'docs-old/guide.md',
      'packages/core/src/index.ts',
      'tests/helpers/setup.md',
      'tests/helpers/setup.ts',
    ]);
    expect(selectPaths(all, 1_000, 'docs')).toEqual(['docs/guide/env.md']);
    /* The whole repository reads the prose in the test folder, not its code. */
    expect(selectPaths(all)).toContain('tests/helpers/setup.md');
    expect(selectPaths(all)).not.toContain('tests/helpers/setup.ts');
    /* A URL pointing into a test folder still reads it. */
    expect(selectPaths(all, 1_000, 'tests/helpers')).toEqual(['tests/helpers/setup.md', 'tests/helpers/setup.ts']);
    /* A file URL reads that file, even a changelog. */
    expect(selectPaths(all, 1_000, 'docs/guide/CHANGELOG.md')).toEqual(['docs/guide/CHANGELOG.md']);
    expect(selectPaths(all, 1_000, 'nowhere')).toEqual([]);
  });
});

describe('reading a ref and folder from GitHub', () => {
  let web: FakeWeb;
  beforeAll(() => {
    web = startFakeWeb(['api.github.com', 'raw.githubusercontent.com']);
  });
  afterAll(() => web.restore());
  afterEach(() => web.routes.clear());

  const repoApi = 'api.github.com/repos/acme/docs';
  function serve(refs: { heads?: string[]; tags?: string[] }, commits: Record<string, string>) {
    web.routes.set(repoApi, () => jsonResponse({ full_name: 'acme/docs', private: false, default_branch: 'main' }));
    for (const namespace of ['heads', 'tags'] as const) {
      const names = refs[namespace] ?? [];
      const firsts = new Set(names.map((name) => name.split('/')[0]!));
      for (const first of firsts) {
        web.routes.set(`${repoApi}/git/matching-refs/${namespace}/${first}`, () =>
          jsonResponse(names.filter((name) => name.startsWith(first)).map((name) => ({ ref: `refs/${namespace}/${name}` }))),
        );
      }
    }
    for (const [ref, sha] of Object.entries(commits)) {
      web.routes.set(`${repoApi}/commits/${encodeURIComponent(ref)}`, (_url, init) =>
        new Headers(init?.headers).get('accept') === 'application/vnd.github.sha' ? text(sha) : jsonResponse({}, 415),
      );
    }
  }
  function serveTree(sha: string, files: Record<string, string>) {
    web.routes.set(`${repoApi}/git/trees/${sha}`, () => jsonResponse({ tree: Object.keys(files).map((path) => ({ path, type: 'blob', size: 10 })) }));
    for (const [path, body] of Object.entries(files)) web.routes.set(`raw.githubusercontent.com/acme/docs/${sha}/${path}`, () => text(body));
  }

  it('reads one folder of a branch whose name has a slash, pinned to its commit', async () => {
    serve({ heads: ['main', 'release/2.x'] }, { 'release/2.x': SHA });
    serveTree(SHA, { 'README.md': '# Root', 'docs/env.md': '# Env', 'docs/CHANGELOG.md': '# Changes', 'src/index.ts': 'x' });
    const ref = parseGithubRepo('https://github.com/acme/docs/tree/release/2.x/docs')!;
    const snapshot = await fetchRepositoryFiles(ref, null, { serverToken: null });
    expect(snapshot.scope).toEqual({ owner: 'acme', name: 'docs', ref: 'release/2.x', path: 'docs' });
    expect(snapshot.revision).toBe(SHA);
    expect(snapshot.files.map((file) => file.path)).toEqual(['docs/env.md']);
    /* The tags were not asked for: a branch matched. */
    expect(web.requests.some((url) => url.includes('matching-refs/tags'))).toBe(false);
  });

  it('falls back to tags, and reads a whole tag when the URL names no folder', async () => {
    serve({ heads: ['main'], tags: ['v2.0.0'] }, { 'v2.0.0': SHA });
    serveTree(SHA, { 'README.md': '# Root' });
    const snapshot = await fetchRepositoryFiles(parseGithubRepo('https://github.com/acme/docs/tree/v2.0.0')!, null, { serverToken: null });
    expect(snapshot).toMatchObject({ revision: SHA, scope: { ref: 'v2.0.0' } });
    expect(snapshot.files.map((file) => file.path)).toEqual(['README.md']);
  });

  it('reads a resumed import at its pinned commit and scope, asking GitHub for neither again', async () => {
    web.requests.length = 0;
    serve({ heads: ['main', 'release/2.x'] }, { 'release/2.x': 'f'.repeat(40) });
    serveTree(SHA, { 'docs/env.md': '# Env at the first attempt', 'README.md': '# Root' });
    const ref = parseGithubRepo('https://github.com/acme/docs/tree/release/2.x/docs')!;
    const snapshot = await fetchRepositoryFiles(ref, null, { serverToken: null, pin: { revision: SHA, scope: { owner: 'acme', name: 'docs', ref: 'release/2.x', path: 'docs' } } });
    expect(snapshot).toMatchObject({ revision: SHA, scope: { ref: 'release/2.x', path: 'docs' } });
    expect(snapshot.files).toEqual([{ path: 'docs/env.md', content: '# Env at the first attempt' }]);
    expect(web.requests.some((url) => url.includes('matching-refs') || url.includes('/commits/') || url.includes('/branches/'))).toBe(false);
  });

  it('says which part is missing: the ref, or the folder', async () => {
    serve({ heads: ['main'] }, { main: SHA });
    serveTree(SHA, { 'README.md': '# Root' });
    await expect(fetchRepositoryFiles(parseGithubRepo('https://github.com/acme/docs/tree/nope')!, null, { serverToken: null }))
      .rejects.toMatchObject({ code: 'github_ref_not_found' });
    await expect(fetchRepositoryFiles(parseGithubRepo('https://github.com/acme/docs/tree/main/missing')!, null, { serverToken: null }))
      .rejects.toMatchObject({ code: 'github_path_not_found' });
  });
});
