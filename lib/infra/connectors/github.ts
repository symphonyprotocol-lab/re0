/**
 * GitHub repositories (rebuild-proposal.md 2.1, from the old
 * `fetchGithubSnapshot`): the default branch's tree is read once through
 * the REST API. File reads are pinned to that commit so a push half-way
 * through cannot mix two versions.
 *
 * Repositories are read with the Ree owner's token from
 * `github_connection`. The token is
 * sent to GitHub's hosts only -- `http.ts` drops it on any redirect away.
 */
import { GITHUB_LIMITS } from '@/lib/constants';
import { parseGithubRepo, type RepositoryRef } from '@/lib/domain/sources';
import { fetchDocument, fetchJson } from './http';
import { ProcessingFailure } from './failure';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const CONCURRENCY = 8;

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

function headers(token: string): Record<string, string> {
  return {
    'x-github-api-version': '2022-11-28',
    authorization: `Bearer ${token}`,
  };
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
 * The repository as `token` sees it, or null when
 * GitHub says there is none -- which is also what it says about a private
 * repository the caller cannot read.
 */
export async function readRepository(ref: RepositoryRef, token: string): Promise<RepositoryInfo | null> {
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
    if (error instanceof ProcessingFailure && (error.code === 'source_missing' || error.httpStatus === 403)) return null;
    throw error;
  }
}

const PROSE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const CODE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|swift|rb|php|c|h|cc|cpp|hpp|cs|scala|sh|bash|sql|ya?ml|toml|vue|svelte|ex|exs|erl|hs|lua|dart|r|jl|m|mm|proto|graphql|gql|tf|ini|cfg|gradle)$/i;
const SKIPPED_DIRS = /(^|\/)(node_modules|vendor|dist|build|out|target|\.git|\.next|coverage|__pycache__|\.venv|venv|third_party)(\/|$)/i;
const SKIPPED_FILES = /(\.min\.(js|css)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$)/i;
const LICENSE = /(^|\/)(license|copying|notice)(\.md|\.txt)?$/i;

/** Documentation and source files worth answering from, prose first and shallow before deep. */
export function selectPaths(entries: readonly { path: string; size?: number }[], limit: number = GITHUB_LIMITS.files): string[] {
  return entries
    .filter(
      (entry) =>
        (entry.size ?? 0) <= GITHUB_LIMITS.fileBytes &&
        (PROSE.test(entry.path) || CODE.test(entry.path)) &&
        !SKIPPED_DIRS.test(entry.path) &&
        !SKIPPED_FILES.test(entry.path) &&
        !LICENSE.test(entry.path),
    )
    .map((entry) => entry.path)
    .sort((a, b) => {
      const prose = Number(!PROSE.test(a)) - Number(!PROSE.test(b));
      if (prose !== 0) return prose;
      const depth = a.split('/').length - b.split('/').length;
      return depth !== 0 ? depth : a < b ? -1 : a > b ? 1 : 0;
    })
    .slice(0, limit);
}

/**
 * The default branch's documentation and source files. Throws
 * `github_repo_not_found` when the repository cannot be read with `token`.
 */
export async function fetchRepositoryFiles(
  ref: RepositoryRef,
  token: string,
): Promise<{ repository: RepositoryInfo; revision: string; files: RepositoryFile[]; truncated: boolean }> {
  const repository = await readRepository(ref, token);
  if (!repository) throw new ProcessingFailure('github_repo_not_found', `${ref.owner}/${ref.name} is not readable`);
  const [owner, name] = repository.fullName.split('/') as [string, string];
  const repoApi = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const branch = await fetchJson<{ commit?: { sha?: string } }>(
    `${repoApi}/branches/${encodeURIComponent(repository.defaultBranch)}`,
    { headers: headers(token) },
  );
  const revision = branch.commit?.sha;
  if (!revision) throw new ProcessingFailure('empty_text', `${repository.fullName} has no commits`);
  const tree = await fetchJson<{ tree?: { path?: string; type?: string; size?: number }[]; truncated?: boolean }>(
    `${repoApi}/git/trees/${revision}?recursive=1`,
    { headers: headers(token), maxBytes: 32 * 1024 * 1024 },
  );
  const blobs = (tree.tree ?? []).filter((entry): entry is { path: string; type: string; size?: number } => entry.type === 'blob' && typeof entry.path === 'string');
  const paths = selectPaths(blobs);
  if (paths.length === 0) throw new ProcessingFailure('empty_text', `${repository.fullName} has no documentation or source files`);

  const files: RepositoryFile[] = [];
  let total = 0;
  let truncated = Boolean(tree.truncated) || blobs.length > paths.length;
  for (let at = 0; at < paths.length; at += CONCURRENCY) {
    const batch = paths.slice(at, at + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((path) => {
        const encodedPath = path.split('/').map(encodeURIComponent).join('/');
        // The Contents API accepts GitHub App user tokens for private repositories.
        const url = repository.private
          ? `${repoApi}/contents/${encodedPath}?ref=${encodeURIComponent(revision)}`
          : `${RAW}/${owner}/${name}/${revision}/${encodedPath}`;
        return fetchDocument(url, {
          accept: repository.private ? 'application/vnd.github.raw+json' : 'text/plain, */*',
          headers: headers(token),
          maxBytes: GITHUB_LIMITS.fileBytes,
        });
      }),
    );
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
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
  return { repository, revision, files, truncated };
}
