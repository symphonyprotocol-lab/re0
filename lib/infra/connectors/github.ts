/**
 * GitHub repositories (rebuild-proposal.md 2.1, from the old
 * `fetchGithubSnapshot`): the tree of the default branch -- or of the
 * branch, tag or commit the URL names (`/tree/<ref>`) -- is read once
 * through the REST API, all of it or one directory (`/tree/<ref>/<path>`).
 * File reads are pinned to that commit so a push half-way through cannot
 * mix two versions. Changelogs, tests, CI files and older copies of
 * versioned docs are left out (`selectPaths`): they crowd the answers out.
 *
 * Repositories are read with the Ree owner's token from
 * `github_connection` when they have one. A public repository needs no
 * connection: when the owner has none, or their token cannot see it (a
 * GitHub App not installed there), it is read with the server's optional
 * `GITHUB_READ_TOKEN` or with no token at all -- and only if GitHub says it
 * is public, so a private repository visible to that server token is never
 * read on an owner's behalf. Unauthenticated, the API allows 60 requests an
 * hour per IP, so an import uses it four times only: the repository when it
 * is added, then the repository, the branch and the tree when it is
 * processed. Public file bodies come from raw.githubusercontent.com at the
 * pinned commit, outside the API quota but throttled too: a throttled read
 * is retried briefly, then fails the whole import as `rate_limited` rather
 * than leave files out. Tokens are sent to GitHub's hosts only -- `http.ts`
 * drops them on any redirect away.
 */
import { GITHUB_LIMITS } from '@/lib/constants';
import { parseGithubRepo, settleTreeRef, type RepositoryRef } from '@/lib/domain/sources';
import { fetchDocument, fetchJson, type FetchedResource, type FetchOptions } from './http';
import { ProcessingFailure } from './failure';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const CONCURRENCY = 8;
/** Retries of one file read, the longest single wait honoured, and all waiting one import may do. */
const READ_RETRIES = 3;
const MAX_WAIT_MS = 20_000;
const WAIT_BUDGET_MS = 60_000;

export interface RepositoryInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface RepositoryFile {
  path: string;
  content: string;
}

export interface GithubRepositoryPage {
  repositories: string[];
  nextPage: number | null;
}

function headers(token: string | null): Record<string, string> {
  return token ? { 'x-github-api-version': '2022-11-28', authorization: `Bearer ${token}` } : { 'x-github-api-version': '2022-11-28' };
}

/** The server's optional token for public repositories (`GITHUB_READ_TOKEN`): it lifts the 60-an-hour anonymous API limit. */
export function serverReadToken(): string | null {
  return process.env.GITHUB_READ_TOKEN?.trim() || null;
}

/** GitHub lists the personal, collaborator and organization repositories visible to this grant. */
export async function listGithubRepositories(token: string, page: number): Promise<GithubRepositoryPage> {
  const params = new URLSearchParams({ per_page: '50', page: String(page), sort: 'full_name', direction: 'asc' });
  const response = await fetchDocument(`${API}/user/repos?${params}`, {
    accept: 'application/vnd.github+json',
    headers: headers(token),
    maxBytes: 2 * 1024 * 1024,
  });
  const entries = JSON.parse(response.body) as { full_name: string }[];
  const repositories = entries.map((entry) => entry.full_name).filter((name) => parseGithubRepo(name) !== null);
  const hasNext = /<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '');
  return { repositories, nextPage: hasNext ? page + 1 : null };
}

/**
 * The repository as `token` (or an anonymous caller) sees it, or null when
 * GitHub says there is none -- which is also what it says about a private
 * repository the caller cannot read.
 */
export async function readRepository(ref: RepositoryRef, token: string | null): Promise<RepositoryInfo | null> {
  try {
    const repository = await fetchJson<{ full_name?: string; private?: boolean; default_branch?: string }>(
      `${API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`,
      { headers: headers(token) },
    );
    return {
      fullName: repository.full_name ?? `${ref.owner}/${ref.name}`,
      private: repository.private === true,
      defaultBranch: repository.default_branch ?? 'HEAD',
    };
  } catch (error) {
    /* A plain 403 hides a repository like a 404 does; a throttling 403 is `rate_limited` and goes through. */
    if (error instanceof ProcessingFailure && (error.code === 'source_missing' || (error.code === 'source_forbidden' && error.httpStatus === 403))) return null;
    throw error;
  }
}

export type RepositoryAccess =
  | { ok: true; repository: RepositoryInfo; token: string | null }
  /* `not_connected`: there is no owner token that works, and no public repository by that name. */
  | { ok: false; reason: 'not_connected' | 'not_found' };

export interface AccessOptions {
  /** Defaults to `serverReadToken()`. */
  serverToken?: string | null;
  read?: (ref: RepositoryRef, token: string | null) => Promise<RepositoryInfo | null>;
}

function forbidden(error: unknown): boolean {
  return error instanceof ProcessingFailure && error.code === 'source_forbidden';
}

/**
 * Which token reads `ref`: the owner's when it can see the repository
 * (public or private), otherwise the server's read token or none -- for a
 * public repository only. Without a usable owner token the refusal is
 * `not_connected` whether the repository is private or missing, so it says
 * nothing about which; with one it stays `not_found`, as before.
 */
export async function resolveRepository(ref: RepositoryRef, ownerToken: string | null, options: AccessOptions = {}): Promise<RepositoryAccess> {
  const read = options.read ?? readRepository;
  const serverToken = options.serverToken === undefined ? serverReadToken() : options.serverToken;
  let ownerWorks = false;
  if (ownerToken) {
    try {
      const repository = await read(ref, ownerToken);
      if (repository) return { ok: true, repository, token: ownerToken };
      ownerWorks = true;
    } catch (error) {
      /* A token GitHub no longer honours is no connection at all. */
      if (!forbidden(error)) throw error;
    }
  }
  for (const token of serverToken ? [serverToken, null] : [null]) {
    let repository: RepositoryInfo | null;
    try {
      repository = await read(ref, token);
    } catch (error) {
      /* Only a server token GitHub no longer honours falls back to anonymous reads. */
      if (token && forbidden(error)) continue;
      throw error;
    }
    if (repository && !repository.private) return { ok: true, repository, token };
    /* Missing or private for the server token: anonymously it would be no different. */
    break;
  }
  return { ok: false, reason: ownerWorks ? 'not_found' : 'not_connected' };
}

export interface ReadOptions extends AccessOptions {
  /** Waits between retries; tests pass one that does not. */
  sleep?: (ms: number) => Promise<void>;
  /** A resumed import: read this commit and scope again, without settling the ref or asking for the newest commit. */
  pin?: { revision: string; scope: RepositoryRef };
}

/**
 * How long to wait before retrying a throttled or unanswered file read, or
 * null to give up: at most `READ_RETRIES` times, honouring the source's
 * `retry-after` unless it is longer than `MAX_WAIT_MS`.
 */
export function retryDelay(error: unknown, attempt: number): number | null {
  if (!(error instanceof ProcessingFailure) || (error.code !== 'rate_limited' && error.code !== 'source_unreachable')) return null;
  if (attempt >= READ_RETRIES) return null;
  const wait = error.retryAfterMs ?? 1000 * 2 ** attempt;
  return wait <= MAX_WAIT_MS ? wait : null;
}

async function readWithRetries(url: string, options: FetchOptions, sleep: (ms: number) => Promise<void>, budget: { waited: number }): Promise<FetchedResource> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchDocument(url, options);
    } catch (error) {
      const wait = retryDelay(error, attempt);
      if (wait === null || budget.waited + wait > WAIT_BUDGET_MS) throw error;
      budget.waited += wait;
      await sleep(wait);
    }
  }
}

const PROSE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const CODE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|swift|rb|php|c|h|cc|cpp|hpp|cs|scala|sh|bash|sql|ya?ml|toml|vue|svelte|ex|exs|erl|hs|lua|dart|r|jl|m|mm|proto|graphql|gql|tf|ini|cfg|gradle)$/i;
const SKIPPED_DIRS = /(^|\/)(node_modules|vendor|dist|build|out|target|\.git|\.next|coverage|__pycache__|\.venv|venv|third_party)(\/|$)/i;
const SKIPPED_FILES = /(\.min\.(js|css)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$)/i;
const LICENSE = /(^|\/)(license|copying|notice)(\.md|\.txt)?$/i;
/*
 * Noise that buries the docs in the answers: release notes (a package's
 * CHANGELOG names every API it ever had), pending changesets, CI and issue
 * templates, Docusaurus's frozen copies of older docs, and test code and its
 * fixtures. The test rules apply to code only: prose that happens to live
 * in a `test/` folder (a guide to testing, say) is still read. Source code
 * itself stays.
 */
const CHANGELOG = /(^|\/)(changelog[^/]*|history)\.(md|mdx|markdown|txt|rst|adoc)$/i;
const NOISE_DIRS = /(^|\/)(\.changeset|\.github|versioned_docs|versioned_sidebars)\//i;
const TEST_DIRS = /(^|\/)(__tests__|__mocks__|__snapshots__|__fixtures__|fixtures|testdata|tests?|e2e)\//i;
const TEST_FILES = /(\.(test|spec)\.[a-z0-9]+$)|((^|\/)test_[^/]*\.py$)|(_test\.(go|py)$)/i;
/** An older version directory is dropped only when it and the newest are copies of one doc tree: this many files each, this much alike. */
const COPY_MIN_FILES = 3;
const COPY_MIN_OVERLAP = 0.5;

/** A directory named like a version: a date (`2025-06-18`), `v2`, `v1.4` or `3.0.1`; plain numbers are chapters, not versions. */
export function versionOf(segment: string): { kind: 'date' | 'number'; parts: number[] } | null {
  const date = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(segment);
  if (date) return { kind: 'date', parts: date.slice(1).filter(Boolean).map(Number) };
  const number = /^(?:version-)?(?:v(\d+(?:\.\d+)*)|(\d+(?:\.\d+)+))$/i.exec(segment);
  if (number) return { kind: 'number', parts: (number[1] ?? number[2])!.split('.').map(Number) };
  return null;
}

function newer(a: number[], b: number[]): boolean {
  for (let at = 0; at < Math.max(a.length, b.length); at += 1) {
    const difference = (a[at] ?? 0) - (b[at] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

/** Shared files over all files of two directories (Jaccard): 1 for the same file set, 0 for none in common. */
function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const name of a) if (b.has(name)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Paths inside an older copy of versioned docs. Where one directory holds
 * version-named directories of the same kind (dates, or numbers), an older
 * one is dropped only when it is a copy of the newest: both hold at least
 * `COPY_MIN_FILES` files and at least `COPY_MIN_OVERLAP` of their relative
 * paths are the same. Dated archives (`blog/2024-05/` and `blog/2024-06/`
 * with different posts), single-file release notes and numbered chapters
 * are different documents, and stay. Unversioned siblings (`draft`,
 * `latest`) always stay.
 */
export function olderVersionPaths(paths: readonly string[]): Set<string> {
  /* group (parent + version kind) → version directory → the paths below it */
  const groups = new Map<string, Map<string, { parts: number[]; files: Set<string> }>>();
  for (const path of paths) {
    const segments = path.split('/');
    segments.slice(0, -1).forEach((segment, at) => {
      const version = versionOf(segment);
      if (!version) return;
      const key = `${segments.slice(0, at).join('/')}|${version.kind}`;
      const members = groups.get(key) ?? new Map<string, { parts: number[]; files: Set<string> }>();
      const member = members.get(segment) ?? { parts: version.parts, files: new Set<string>() };
      member.files.add(segments.slice(at + 1).join('/'));
      members.set(segment, member);
      groups.set(key, members);
    });
  }
  const copies = new Map<string, Set<string>>();
  for (const [key, members] of groups) {
    if (members.size < 2) continue;
    const [newestSegment, newest] = [...members].reduce((best, entry) => (newer(entry[1].parts, best[1].parts) ? entry : best));
    if (newest.files.size < COPY_MIN_FILES) continue;
    const dropped = new Set<string>();
    for (const [segment, member] of members) {
      if (segment !== newestSegment && member.files.size >= COPY_MIN_FILES && overlap(member.files, newest.files) >= COPY_MIN_OVERLAP) dropped.add(segment);
    }
    if (dropped.size > 0) copies.set(key, dropped);
  }
  const older = new Set<string>();
  for (const path of paths) {
    const segments = path.split('/').slice(0, -1);
    const stale = segments.some((segment, at) => {
      const version = versionOf(segment);
      return version !== null && (copies.get(`${segments.slice(0, at).join('/')}|${version.kind}`)?.has(segment) ?? false);
    });
    if (stale) older.add(path);
  }
  return older;
}

/** The scope's own path when it names one file, else the paths below the directory it names (all of them without one). */
function inScope(path: string, scope: string | undefined): string | null {
  if (!scope) return path;
  if (path === scope) return path.slice(path.lastIndexOf('/') + 1);
  return path.startsWith(`${scope}/`) ? path.slice(scope.length + 1) : null;
}

/**
 * Documentation and source files worth answering from, prose first and
 * shallow before deep: within `scope` (a directory or one file) when the URL
 * named one, leaving out noise as above. The noise rules look at the path
 * below the scope, so a URL that points into a test or version directory
 * still reads it. `olderVersions` counts the files left out as older copies
 * of versioned docs, for the processing record.
 */
export function selectRepositoryPaths(
  entries: readonly { path: string; size?: number }[],
  limit: number = GITHUB_LIMITS.files,
  scope?: string,
): { paths: string[]; olderVersions: number } {
  const candidates = entries.flatMap((entry) => {
    const relative = inScope(entry.path, scope);
    if (relative === null) return [];
    const prose = PROSE.test(entry.path);
    const ok =
      (entry.size ?? 0) <= GITHUB_LIMITS.fileBytes &&
      (prose || CODE.test(entry.path)) &&
      !SKIPPED_DIRS.test(relative) &&
      !SKIPPED_FILES.test(relative) &&
      !LICENSE.test(relative) &&
      (entry.path === scope || (!CHANGELOG.test(relative) && !NOISE_DIRS.test(relative) && (prose || (!TEST_DIRS.test(relative) && !TEST_FILES.test(relative)))));
    return ok ? [{ path: entry.path, relative }] : [];
  });
  const older = olderVersionPaths(candidates.map((candidate) => candidate.relative));
  const paths = candidates
    .filter((candidate) => !older.has(candidate.relative))
    .map((candidate) => candidate.path)
    .sort((a, b) => {
      const prose = Number(!PROSE.test(a)) - Number(!PROSE.test(b));
      if (prose !== 0) return prose;
      const depth = a.split('/').length - b.split('/').length;
      return depth !== 0 ? depth : a < b ? -1 : a > b ? 1 : 0;
    })
    .slice(0, limit);
  return { paths, olderVersions: older.size };
}

export function selectPaths(entries: readonly { path: string; size?: number }[], limit: number = GITHUB_LIMITS.files, scope?: string): string[] {
  return selectRepositoryPaths(entries, limit, scope).paths;
}

function notFound(error: unknown): boolean {
  return error instanceof ProcessingFailure && (error.code === 'source_missing' || error.httpStatus === 404 || error.httpStatus === 422);
}

/**
 * A `/tree/a/b/...` URL split between ref and path against the
 * repository's branches (then tags) that start with `a` -- one API call,
 * two when no branch matches.
 */
export async function settleRef(repoApi: string, ref: RepositoryRef, token: string | null): Promise<RepositoryRef> {
  if (!ref.refUnsettled || !ref.ref) return ref;
  const first = ref.ref.split('/')[0]!;
  const names = async (namespace: 'heads' | 'tags'): Promise<string[]> => {
    const refs = await fetchJson<{ ref?: string }[]>(`${repoApi}/git/matching-refs/${namespace}/${encodeURIComponent(first)}`, { headers: headers(token), maxBytes: 4 * 1024 * 1024 });
    const prefix = `refs/${namespace}/`;
    return (Array.isArray(refs) ? refs : []).map((entry) => entry.ref ?? '').filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length));
  };
  const longer = (list: string[]) => list.some((name) => name === first || name.startsWith(`${first}/`));
  let known = await names('heads');
  if (!longer(known)) known = [...known, ...(await names('tags'))];
  return settleTreeRef(ref, known);
}

/** The commit a branch, tag or SHA names, or null when GitHub knows none by that name. */
export async function commitOf(repoApi: string, ref: string, token: string | null): Promise<string | null> {
  try {
    const response = await fetchDocument(`${repoApi}/commits/${encodeURIComponent(ref)}`, { accept: 'application/vnd.github.sha', headers: headers(token), maxBytes: 4096 });
    const sha = response.body.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

function repositoryApi(repository: RepositoryInfo): string {
  const [owner, name] = repository.fullName.split('/') as [string, string];
  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/**
 * When a source is added: the URL's ref settled against the repository and
 * checked to exist, so a mistyped branch is refused at once rather than
 * failing later. Answers the ref as it will be stored; a URL without a ref
 * costs nothing here.
 */
export async function checkRepositoryScope(ref: RepositoryRef, repository: RepositoryInfo, token: string | null): Promise<RepositoryRef | null> {
  if (!ref.ref) return ref;
  const repoApi = repositoryApi(repository);
  const settled = await settleRef(repoApi, ref, token);
  return (await commitOf(repoApi, settled.ref!, token)) ? settled : null;
}

/**
 * The documentation and source files of the default branch, or of the ref
 * and directory the URL names, read as `resolveRepository` decides. Throws
 * `github_not_connected` or `github_repo_not_found` when it finds no way to
 * read the repository, `github_ref_not_found` / `github_path_not_found` when
 * the named ref or directory is not there, and `rate_limited` when GitHub
 * still throttles a file read after the retries. A file GitHub no longer
 * has (or binary) is skipped; one it would not serve is counted in `unread`
 * and marks the snapshot `truncated`.
 */
export async function fetchRepositoryFiles(
  ref: RepositoryRef,
  ownerToken: string | null,
  options: ReadOptions = {},
): Promise<{ repository: RepositoryInfo; revision: string; scope: RepositoryRef; files: RepositoryFile[]; truncated: boolean; unread: number; olderVersions: number }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const access = await resolveRepository(ref, ownerToken, options);
  if (!access.ok) {
    throw new ProcessingFailure(
      access.reason === 'not_found' ? 'github_repo_not_found' : 'github_not_connected',
      `${ref.owner}/${ref.name} is not readable${access.reason === 'not_found' ? '' : ' without a GitHub connection'}`,
    );
  }
  const { repository, token } = access;
  const [owner, name] = repository.fullName.split('/') as [string, string];
  const repoApi = repositoryApi(repository);
  const scope = options.pin ? options.pin.scope : await settleRef(repoApi, ref, token);
  let revision: string | null | undefined;
  if (options.pin) {
    revision = options.pin.revision;
  } else if (scope.ref) {
    revision = await commitOf(repoApi, scope.ref, token);
    if (!revision) throw new ProcessingFailure('github_ref_not_found', `${repository.fullName} has no ref ${scope.ref}`);
  } else {
    const branch = await fetchJson<{ commit?: { sha?: string } }>(
      `${repoApi}/branches/${encodeURIComponent(repository.defaultBranch)}`,
      { headers: headers(token) },
    );
    revision = branch.commit?.sha;
  }
  if (!revision) throw new ProcessingFailure('empty_text', `${repository.fullName} has no commits`);
  const tree = await fetchJson<{ tree?: { path?: string; type?: string; size?: number }[]; truncated?: boolean }>(
    `${repoApi}/git/trees/${revision}?recursive=1`,
    { headers: headers(token), maxBytes: 32 * 1024 * 1024 },
  );
  const blobs = (tree.tree ?? []).filter((entry): entry is { path: string; type: string; size?: number } => entry.type === 'blob' && typeof entry.path === 'string');
  const { paths, olderVersions } = selectRepositoryPaths(blobs, GITHUB_LIMITS.files, scope.path);
  const label = `${repository.fullName}${scope.path ? `/${scope.path}` : ''}`;
  if (paths.length === 0) {
    const exists = !scope.path || blobs.some((entry) => entry.path === scope.path || entry.path.startsWith(`${scope.path}/`));
    /* A truncated tree may simply not list the directory: say so as missing only when the listing was whole. */
    if (!exists && !tree.truncated) throw new ProcessingFailure('github_path_not_found', `${repository.fullName} has no ${scope.path} at ${revision.slice(0, 7)}`);
    throw new ProcessingFailure('empty_text', `${label} has no documentation or source files`);
  }

  const files: RepositoryFile[] = [];
  const budget = { waited: 0 };
  let unread = 0;
  let total = 0;
  /* Only a cut-off listing or the file limit truncates; files left out as noise do not. */
  let truncated = Boolean(tree.truncated) || paths.length >= GITHUB_LIMITS.files;
  for (let at = 0; at < paths.length; at += CONCURRENCY) {
    const batch = paths.slice(at, at + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((path) => {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        // The Contents API accepts GitHub App user tokens for private repositories;
        // public bodies come from raw.githubusercontent.com, outside the API quota.
        const url = repository.private
          ? `${repoApi}/contents/${encodedPath}?ref=${encodeURIComponent(revision)}`
          : `${RAW}/${owner}/${name}/${revision}/${encodedPath}`;
        return readWithRetries(
          url,
          { accept: repository.private ? 'application/vnd.github.raw+json' : 'text/plain, */*', headers: headers(token), maxBytes: GITHUB_LIMITS.fileBytes },
          sleep,
          budget,
        );
      }),
    );
    const throttle = results.find((result) => result.status === 'rejected' && result.reason instanceof ProcessingFailure && result.reason.code === 'rate_limited');
    if (throttle) throw new ProcessingFailure('rate_limited', `GitHub kept throttling file reads of ${repository.fullName}`);
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') {
        if (!(result.reason instanceof ProcessingFailure && result.reason.code === 'source_missing')) {
          unread += 1;
          truncated = true;
        }
        return;
      }
      /* Binary files that slipped through the extension filter. */
      if (result.value.body.includes('\u0000')) return;
      total += result.value.body.length;
      if (total > GITHUB_LIMITS.totalBytes) {
        truncated = true;
        return;
      }
      files.push({ path: batch[index]!, content: result.value.body.replace(/\r\n?/g, '\n') });
    });
    if (total > GITHUB_LIMITS.totalBytes) break;
  }
  if (files.length === 0) throw new ProcessingFailure('source_unreachable', `no file of ${repository.fullName} could be read`);
  if (unread > 0) console.warn(`[github] ${repository.fullName}@${revision.slice(0, 7)}: ${unread} of ${paths.length} files could not be read`);
  return { repository, revision, scope, files, truncated, unread, olderVersions };
}
