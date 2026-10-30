/**
 * Git repositories, over the GitHub REST API and the raw content host.
 *
 * The tree is read once through the API and the files themselves come from
 * `raw.githubusercontent.com`, pinned to the commit the tree was read at. Two
 * reasons: the API's contents endpoint costs one rate-limited call per file,
 * and pinning to a sha is what makes the snapshot immutable -- a build that
 * fetched half its files before a push and half after would freeze a commit
 * that never existed (requirement.md 8.1 requires an immutable snapshot).
 */
import {
  documentFormat,
  isFallbackDocument,
  IngestionFailure,
  INGESTION_LIMITS,
  parseSourceConfig,
  pathIncluded,
  type SourceConfig,
} from '@/lib/domain/ingestion';
import { fetchDocument, fetchJson } from './http';
import type { SourceSnapshot } from './types';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

/**
 * Below this many prose documents a public repository is allowed to fall back
 * to its source files. requirement.md 8.1: "仓库文档不足时，公开库可从源代码
 * 生成说明". Platform assets are public by definition, so the fallback is
 * available to every asset this connector builds.
 */
const PROSE_FLOOR = 3;

const LICENSE_FILES = new Set(['license', 'license.md', 'license.txt', 'copying', 'copying.md']);

interface Repository {
  default_branch?: string;
  pushed_at?: string;
  archived?: boolean;
  private?: boolean;
  license?: { spdx_id?: string } | null;
}

interface TreeEntry {
  path?: string;
  type?: string;
  size?: number;
}

interface Tree {
  tree?: TreeEntry[];
  truncated?: boolean;
}

interface Commit {
  sha?: string;
  commit?: { committer?: { date?: string } };
}

/**
 * An optional token, raising the anonymous rate limit from 60 requests an hour.
 *
 * Read-only and unrelated to the OAuth app: architecture.md 5.4 keeps a user's
 * repository grant for claims, and ingestion of a public repository must not
 * borrow anybody's credential to read what is already public.
 */
function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_INGESTION_TOKEN;
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export async function fetchGithubSnapshot(input: {
  /** `owner/repository`, as `normalizeLocation` produced it. */
  location: string;
}): Promise<SourceSnapshot> {
  const [owner, name] = input.location.split('/');
  if (!owner || !name) {
    throw new IngestionFailure('source_unsupported', 'validate-source', 'not a repository');
  }

  const repository = await fetchJson<Repository>(`${API}/repos/${owner}/${name}`, {
    headers: authHeaders(),
  });
  if (repository.private) {
    throw new IngestionFailure('source_forbidden', 'fetch-snapshot', 'the repository is private');
  }

  const config = await readConfig(owner, name, repository.default_branch ?? 'HEAD');
  const branch = config.branch ?? repository.default_branch ?? 'HEAD';

  const head = await fetchJson<Commit[]>(
    `${API}/repos/${owner}/${name}/commits?sha=${encodeURIComponent(branch)}&per_page=1`,
    { headers: authHeaders() },
  );
  const revision = head[0]?.sha;
  if (!revision) {
    throw new IngestionFailure('source_empty', 'fetch-snapshot', 'the branch has no commits');
  }

  const tree = await fetchJson<Tree>(
    `${API}/repos/${owner}/${name}/git/trees/${revision}?recursive=1`,
    { headers: authHeaders(), maxBytes: 16 * 1024 * 1024 },
  );

  const entries = (tree.tree ?? []).filter(
    (entry): entry is TreeEntry & { path: string } =>
      entry.type === 'blob' && typeof entry.path === 'string',
  );

  const hasLicense = entries.some((entry) => LICENSE_FILES.has(entry.path.toLowerCase()));
  const selected = selectPaths(entries, config);
  if (selected.length === 0) {
    throw new IngestionFailure('source_empty', 'discover-parse', 'no indexable documents');
  }

  const files: SourceSnapshot['files'] = [];
  let bytes = 0;
  for (const path of selected) {
    const url = `${RAW}/${owner}/${name}/${revision}/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    const resource = await fetchDocument(url, {
      maxBytes: INGESTION_LIMITS.maxDocumentBytes,
      headers: authHeaders(),
    });
    bytes += resource.bytes;
    if (bytes > INGESTION_LIMITS.maxSnapshotBytes) {
      throw new IngestionFailure('source_too_large', 'fetch-snapshot', 'the repository is too large');
    }
    files.push({
      path,
      /* The blob URL a reader can open, not the raw one a machine fetched. */
      url: `https://github.com/${owner}/${name}/blob/${revision}/${path}`,
      content: resource.body,
    });
  }

  return {
    files,
    config,
    revision,
    lastModifiedAt: parseDate(head[0]?.commit?.committer?.date ?? repository.pushed_at),
    hasLicense: hasLicense || Boolean(repository.license?.spdx_id),
    /** An archived repository is still readable, but it is not maintained. */
    stale: repository.archived === true,
  };
}

/**
 * Chooses what to index: prose first, source code only when there is too little.
 *
 * The order matters more than the filter does. requirement.md 8.1 puts
 * documents and examples first, and a repository with a `docs/` tree and ten
 * thousand `.ts` files would otherwise be indexed as a TypeScript codebase with
 * some documentation in it.
 */
function selectPaths(entries: readonly { path: string; size?: number }[], config: SourceConfig): string[] {
  const withinSize = entries.filter(
    (entry) => (entry.size ?? 0) <= INGESTION_LIMITS.maxDocumentBytes,
  );

  const prose = withinSize
    .filter((entry) => documentFormat(entry.path) !== null && pathIncluded(entry.path, config))
    .map((entry) => entry.path)
    .sort(byDepthThenName);

  if (prose.length >= PROSE_FLOOR) return prose.slice(0, INGESTION_LIMITS.maxDocuments);

  const fallback = withinSize
    .filter((entry) => isFallbackDocument(entry.path) && pathIncluded(entry.path, config))
    .map((entry) => entry.path)
    .sort(byDepthThenName);

  return [...prose, ...fallback].slice(0, INGESTION_LIMITS.maxDocuments);
}

/** Shallow paths first, so a README leads and `docs/deep/x.md` follows. */
function byDepthThenName(a: string, b: string): number {
  const depth = a.split('/').length - b.split('/').length;
  return depth !== 0 ? depth : a < b ? -1 : a > b ? 1 : 0;
}

/** `re0.json` is optional; its absence is the common case, not an error. */
async function readConfig(owner: string, name: string, branch: string): Promise<SourceConfig> {
  try {
    const resource = await fetchDocument(`${RAW}/${owner}/${name}/${branch}/re0.json`, {
      maxBytes: 64_000,
      headers: authHeaders(),
    });
    return parseSourceConfig(resource.body);
  } catch {
    return parseSourceConfig('');
  }
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
