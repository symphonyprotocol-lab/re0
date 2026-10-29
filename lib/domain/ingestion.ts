/**
 * Ingestion rules, as pure functions. No Next.js, no driver, no fetch.
 *
 * requirement.md 8.1 fixes the order of the pipeline and architecture.md 8.2
 * names its steps. Everything in this module is one of the decisions those two
 * make -- which files are worth indexing, what a document normalizes to, where
 * a chunk boundary falls, what makes a snapshot unsafe, and what a version's
 * digest is -- kept apart from the code that fetches, embeds and writes so the
 * answers are the same in a test as in a worker.
 *
 * Two constants here are part of a published Version's identity: a Version
 * freezes `parser_version` and `chunker_version` (requirement.md 8.1), so a
 * change to how documents are parsed or split must bump the matching constant.
 * Otherwise two versions built by different code claim to be the same build.
 */

/**
 * Bumped whenever `parseDocument` changes what it produces.
 *
 * -2: a document's title now prefers the title the page declares (its
 * `<title>`, or a renderer's metadata) over a heading below level 1, and
 * sheds the site's name from it. Bodies and chunks are unchanged; the bump
 * exists so every library picks the new titles up on its next refresh, which
 * the unchanged-source shortcut would otherwise skip for good.
 */
export const PARSER_VERSION = 're0-parser-2';

/**
 * Bumped whenever `chunkDocument` moves a boundary.
 *
 * -2: `fitBlock` now cuts a line that is longer than a whole chunk, instead of
 * emitting it whole. Only documents holding such a line chunk differently.
 */
export const CHUNKER_VERSION = 're0-chunker-2';

/* ------------------------------------------------------------------ states */

/**
 * The operation states architecture.md 8.1 draws.
 *
 * Stored on `workflow_operation.status`, which is free-form text, so this is
 * the whole vocabulary the column is allowed to hold. `pending` and `running`
 * are what `manage-platform-libraries` already treats as an open operation, so
 * every stage between the two ends maps onto `running` on the row and is
 * reported separately.
 *
 * `cancelled` is the one state a row reaches without running: deleting a
 * library withdraws every operation still queued for it (architecture.md
 * 8.4), and a queued build that is silently dropped would leave the console
 * showing work that will never happen.
 */
export const OPERATION_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;

export type OperationState = (typeof OPERATION_STATES)[number];

/**
 * Who asked for an operation: an operator pressing a button, or the scheduled
 * drain acting on a source's refresh policy. Kept on the row so the queue can
 * say which, and so an audit reader is not left looking for an administrator
 * behind a refresh nobody requested.
 *
 * `platform` is the platform's own decision -- a rebuild forced by a parser,
 * chunker or model upgrade, or the first refresh of a library that predates
 * per-source digests. library-build-billing.md 5.4: such a build is never the
 * owner's bill, whatever it measures.
 */
export const OPERATION_TRIGGERS = ['manual', 'scheduled', 'platform'] as const;

export type OperationTrigger = (typeof OPERATION_TRIGGERS)[number];

export function isOperationTrigger(value: unknown): value is OperationTrigger {
  return typeof value === 'string' && (OPERATION_TRIGGERS as readonly string[]).includes(value);
}

/**
 * The steps of architecture.md 8.2, in the order they run -- plus `purge`,
 * the Delete Workflow's single step (architecture.md 8.4), which runs on its
 * own operation rather than as part of a build.
 */
export const INGESTION_STAGES = [
  'validate-source',
  'fetch-snapshot',
  'scan',
  'discover-parse',
  'normalize-cite',
  'chunk',
  'embed-index',
  'profile',
  'evaluate',
  'publish',
  'purge',
] as const;

export type IngestionStage = (typeof INGESTION_STAGES)[number];

/**
 * What a build has counted so far, for the console's queue row. Every field
 * appears once its stage has produced it: files after the fetch, documents
 * after parsing, the chunk total after chunking, and `chunksDone` growing by
 * one embedding window at a time until it meets the total.
 */
export interface BuildProgress {
  files?: number;
  documents?: number;
  chunksTotal?: number;
  chunksDone?: number;
}

/* ------------------------------------------------------------ fetch method */

/**
 * How a page's bytes were obtained. `direct` is our own fetch; the others are
 * a rendering provider (`lib/infrastructure/connectors/render.ts`), reached
 * only as a fallback when a site refuses the plain fetch or serves a script
 * shell. The console shows this per operation, because a page rendered
 * elsewhere is a page whose content we did not fetch ourselves, and an
 * operator deciding whether to pay for a renderer wants to know how often it
 * was needed.
 */
export type FetchMethod = 'direct' | 'firecrawl' | 'anysearch' | 'jina';

export interface FetchSummary {
  /** Pages our own fetch answered. */
  direct: number;
  /** Pages a rendering provider answered. */
  rendered: number;
  /** The provider that rendered them; null when none did. */
  renderer: Exclude<FetchMethod, 'direct'> | null;
}

/**
 * Tallies how one snapshot's files were fetched, or null when no file says --
 * a repository or a Notion space has no fetch method to report, and the
 * console shows nothing rather than "direct" for a choice that never existed.
 */
export function summarizeFetch(
  files: readonly { fetchedVia?: FetchMethod }[],
): FetchSummary | null {
  let direct = 0;
  let rendered = 0;
  let renderer: FetchSummary['renderer'] = null;
  for (const file of files) {
    if (!file.fetchedVia) continue;
    if (file.fetchedVia === 'direct') {
      direct += 1;
    } else {
      rendered += 1;
      renderer = file.fetchedVia;
    }
  }
  if (direct === 0 && rendered === 0) return null;
  return { direct, rendered, renderer };
}

/* ------------------------------------------------------------------ errors */

/**
 * Why an ingestion run stopped.
 *
 * Deliberately a small, stable set: these end up on `workflow_operation.error`,
 * which the console prints, and a free-text message from a provider would put
 * fetched content on an operator's screen (architecture.md 17.1 forbids exactly
 * that in logs, and the queue table is read the same way).
 */
export const INGESTION_ERRORS = [
  'source_unsupported',
  'source_unreachable',
  'source_forbidden',
  'source_too_large',
  /**
   * requirement.md 4.1: the library's content is over its plan's per-library
   * ceiling. Not retried -- the source will be as large next time.
   */
  'library_too_large',
  'source_empty',
  'source_unrendered',
  'unsafe_content',
  'parse_failed',
  'embedding_unavailable',
  'index_incomplete',
  'storage_unavailable',
  'publish_failed',
  /**
   * library-build-billing.md 4.3: chunking measured a price the workspace's
   * allowance and pack balance cannot cover, so the build stopped before
   * embedding. Not retried -- the balance does not change on its own.
   */
  'quota_exceeded',
  'internal_error',
] as const;

export type IngestionErrorCode = (typeof INGESTION_ERRORS)[number];

export function isIngestionError(value: unknown): value is IngestionErrorCode {
  return typeof value === 'string' && (INGESTION_ERRORS as readonly string[]).includes(value);
}

export class IngestionFailure extends Error {
  constructor(
    readonly code: IngestionErrorCode,
    readonly stage: IngestionStage,
    message: string,
    /**
     * The HTTP status behind a failed request, when there was one. Read by
     * the rendering fallback to tell a spent or refused key (402, 401/403,
     * 429) from a page the provider could not render.
     */
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'IngestionFailure';
  }
}

/* ------------------------------------------------------------------ limits */

/**
 * Caps on one build.
 *
 * A platform library is fetched from the open internet, so every one of these
 * is a bound on what a hostile or merely enormous source can cost us. The byte
 * cap matches requirement.md 4.1's accounting: decompressed, pre-normalization
 * content bytes.
 */
export const INGESTION_LIMITS = {
  /** Per file. Bigger documents are almost always generated artefacts. */
  maxDocumentBytes: 1_000_000,
  /** Per build, summed over every file kept. */
  maxSnapshotBytes: 64 * 1024 * 1024,
  /** Per build. Stops a monorepo from becoming one library. */
  maxDocuments: 3_000,
  /** Per build. */
  maxChunks: 60_000,
  /** Hard ceiling for the selectable crawl depth of one site. */
  maxCrawlDepth: 3,
  /** How many pages a crawl may pull. */
  maxCrawlPages: 200,
} as const;

/* ------------------------------------------------------------------ lookup */

/**
 * A lookup that answers only for keys the map actually declares.
 *
 * Every table in this module is keyed by something that arrived from outside:
 * a file extension from a repository tree, an entity name from a fetched page,
 * a language an operator typed. A plain `map[key]` also answers for
 * `Object.prototype` members, so `&constructor;` in someone's HTML resolves to
 * the source text of `Object` and gets spliced into the indexed document, and a
 * library whose language reads `constructor` produces a `search_config` the
 * CHECK constraint rejects. Both were real; this is why nothing here indexes a
 * map directly.
 */
function lookup<T>(map: Record<string, T>, key: string): T | null {
  return Object.hasOwn(map, key) ? (map[key] as T) : null;
}

/* --------------------------------------------------------------- documents */

export type DocumentFormat = 'markdown' | 'text' | 'html' | 'structured';

/**
 * The file extensions worth indexing, and what each parses as.
 *
 * requirement.md 8.1 says documents and examples come first, so this is
 * documentation and interface description -- not source code. Source code is
 * allowed as a fallback for a public library whose repository has too little
 * prose, which `isFallbackDocument` answers separately so the caller has to opt
 * into it rather than getting it by accident.
 */
const DOCUMENT_FORMATS: Record<string, DocumentFormat> = {
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  rst: 'text',
  txt: 'text',
  adoc: 'text',
  html: 'html',
  htm: 'html',
  json: 'structured',
  yaml: 'structured',
  yml: 'structured',
};

/** Source files a documentation-poor repository may fall back to. */
const FALLBACK_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'rb']);

/**
 * Directories never worth fetching.
 *
 * Vendored dependencies and build output are copies of material that is either
 * already indexed elsewhere or not documentation at all, and they dominate a
 * repository's file count. Excluded before the include rules run, because the
 * cost they avoid is the fetch, not the parse.
 */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '__pycache__',
  'coverage',
  'fixtures',
  'testdata',
]);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function documentFormat(path: string): DocumentFormat | null {
  return lookup(DOCUMENT_FORMATS, extensionOf(path));
}

export function isFallbackDocument(path: string): boolean {
  return FALLBACK_EXTENSIONS.has(extensionOf(path));
}

/** Dot directories are skipped too: `.github`, `.next` and friends are tooling. */
export function isIgnoredPath(path: string): boolean {
  return path
    .split('/')
    .some((segment) => IGNORED_SEGMENTS.has(segment) || segment.startsWith('.'));
}

/* ---------------------------------------------------------------- re0.json */

/**
 * The source-side configuration requirement.md 7.2 allows in a repository root.
 *
 * Everything here is a *hint about what to index*. Nothing in it grants
 * anything: 7.2 is explicit that a key, token or claim in this file confers no
 * permission, because the set of people who can write the file is not the set
 * of people who control the source. So there is no field for one, and an
 * unknown field is dropped rather than kept "just in case".
 */
export interface SourceConfig {
  projectTitle: string | null;
  description: string | null;
  branch: string | null;
  folders: string[];
  excludeFolders: string[];
  excludeFiles: string[];
  /** Returned to agents as advice. Never promoted to a system instruction. */
  rules: string[];
}

export const EMPTY_SOURCE_CONFIG: SourceConfig = {
  projectTitle: null,
  description: null,
  branch: null,
  folders: [],
  excludeFolders: [],
  excludeFiles: [],
  rules: [],
};

/** Caps from requirement.md 7.2: array length, path length and file size. */
const CONFIG_LIMITS = { maxBytes: 32_000, maxEntries: 64, maxPathLength: 200, maxRuleLength: 400 };

/**
 * Parses `re0.json`, keeping only what is both known and well formed.
 *
 * Never throws. A malformed configuration file in someone's repository is not
 * a reason to fail their build -- it is a reason to index the repository as if
 * the file were absent, which is exactly what an empty config does.
 */
export function parseSourceConfig(raw: string): SourceConfig {
  if (raw.length > CONFIG_LIMITS.maxBytes) return EMPTY_SOURCE_CONFIG;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_SOURCE_CONFIG;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return EMPTY_SOURCE_CONFIG;
  }
  const record = parsed as Record<string, unknown>;

  return {
    projectTitle: text(record.projectTitle, 120),
    description: text(record.description, 400),
    branch: branchName(record.branch),
    folders: paths(record.folders),
    excludeFolders: paths(record.excludeFolders),
    excludeFiles: paths(record.excludeFiles),
    rules: list(record.rules, CONFIG_LIMITS.maxRuleLength),
  };
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** Git ref characters only, so a branch cannot smuggle a path or a flag. */
function branchName(value: unknown): string | null {
  const name = text(value, 100);
  return name && /^[A-Za-z0-9._/-]+$/.test(name) && !name.includes('..') ? name : null;
}

function list(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const kept: string[] = [];
  for (const entry of value.slice(0, CONFIG_LIMITS.maxEntries)) {
    const item = text(entry, max);
    if (item) kept.push(item);
  }
  return kept;
}

/**
 * Repository-relative paths and globs.
 *
 * Absolute paths and `..` are dropped rather than resolved: a configuration
 * file cannot be allowed to name anything outside the snapshot it describes,
 * and silently clamping one would leave the author believing it worked.
 */
function paths(value: unknown): string[] {
  return list(value, CONFIG_LIMITS.maxPathLength)
    .filter(
      (entry) =>
        !entry.startsWith('/') && !entry.includes('..') && !entry.includes('\\'),
    )
    .map((entry) => entry.replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter((entry) => entry.length > 0);
}

/**
 * A `*` / `**` glob, anchored at both ends.
 *
 * Only the two wildcards requirement.md 7.2's example uses are supported. `*`
 * stops at a path separator and `**` crosses them, which is what the example's
 * `**` + `/legacy` pattern has to mean to be useful.
 */
function globMatches(pattern: string, path: string): boolean {
  const expression = pattern
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${expression}$`).test(path);
}

/**
 * Whether one repository path survives the configuration's rules.
 *
 * Exclusions win, which requirement.md 7.2 states outright. A path is excluded
 * when it matches an exclude glob or sits under an excluded folder; when
 * `folders` is set, everything outside those folders is excluded too -- except
 * root-level documents, which 7.2 requires the schema to be explicit about, and
 * this is that decision: a repository's root README is always a candidate,
 * because a `folders: ["docs"]` that hid the README would produce a library
 * whose front page is missing.
 */
export function pathIncluded(path: string, config: SourceConfig): boolean {
  if (isIgnoredPath(path)) return false;

  const name = path.slice(path.lastIndexOf('/') + 1);
  for (const pattern of config.excludeFiles) {
    if (globMatches(pattern, path) || pattern === name) return false;
  }
  for (const folder of config.excludeFolders) {
    if (path === folder || path.startsWith(`${folder}/`)) return false;
    if (globMatches(folder, path) || globMatches(`${folder}/**`, path)) return false;
  }

  if (config.folders.length === 0) return true;
  if (!path.includes('/')) return true;
  return config.folders.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

/* ---------------------------------------------------------------- scanning */

/**
 * What a scan found. architecture.md 8.2 step 3.
 *
 * `secrets` quarantines the document: republishing someone's leaked key under
 * our own name is the one finding that cannot be shipped with a warning. The
 * other two are recorded on the chunk and let through -- a document that
 * mentions "ignore previous instructions" is very often documentation *about*
 * prompt injection, and dropping it would make us useless on the topic.
 */
export interface ScanFindings {
  secrets: boolean;
  promptInjection: boolean;
  personalData: boolean;
}

export type SafetyStatus = 'clean' | 'flagged' | 'quarantined';

/**
 * Credential shapes with a fixed, unmistakable prefix.
 *
 * Prefix-anchored on purpose. A generic "long random string" rule matches
 * hashes, minified code and base64 images, and a scanner that quarantines half
 * a documentation site is a scanner that gets turned off.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
];

/** Phrasing that only appears when text is addressing a model, not a reader. */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (?:all )?(?:previous|prior|above) instructions/i,
  /disregard (?:all )?(?:previous|prior|above) (?:instructions|rules)/i,
  /you are now (?:a|an|in) [a-z ]{0,20}(?:developer mode|jailbreak)/i,
  /\bsystem prompt\b[^.\n]{0,40}\b(?:reveal|print|output|repeat)\b/i,
];

/** Contact details that should not be republished from a fetched page. */
const PERSONAL_DATA_PATTERNS: RegExp[] = [
  /\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b/,
  /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14})\b/,
];

export function scanContent(value: string): ScanFindings {
  return {
    secrets: SECRET_PATTERNS.some((pattern) => pattern.test(value)),
    promptInjection: INJECTION_PATTERNS.some((pattern) => pattern.test(value)),
    personalData: PERSONAL_DATA_PATTERNS.some((pattern) => pattern.test(value)),
  };
}

export function safetyStatusOf(findings: ScanFindings): SafetyStatus {
  if (findings.secrets) return 'quarantined';
  return findings.promptInjection || findings.personalData ? 'flagged' : 'clean';
}

/**
 * What the scan found, as a list the document row keeps
 * (`document.safety_findings`) so a reviewer sees *why* a document is
 * flagged, not just that it is. A quarantined file never becomes a
 * document, so `secrets` is listed for completeness and appears in no row.
 */
export const SAFETY_FINDINGS = ['secrets', 'prompt_injection', 'personal_data'] as const;

export type SafetyFinding = (typeof SAFETY_FINDINGS)[number];

export function safetyFindingsOf(findings: ScanFindings): SafetyFinding[] {
  const list: SafetyFinding[] = [];
  if (findings.secrets) list.push('secrets');
  if (findings.promptInjection) list.push('prompt_injection');
  if (findings.personalData) list.push('personal_data');
  return list;
}

export function isSafetyFinding(value: unknown): value is SafetyFinding {
  return typeof value === 'string' && (SAFETY_FINDINGS as readonly string[]).includes(value);
}

/* ----------------------------------------------------------------- parsing */

export interface DocumentSection {
  /** Character offset into `body` where the section starts. */
  offset: number;
  heading: string;
  /** Heading level, 1-6. */
  level: number;
}

export interface ParsedDocument {
  /** Path or URL the document came from, as fetched. */
  path: string;
  title: string;
  /** Normalized plain text with markdown headings preserved. */
  body: string;
  sections: DocumentSection[];
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

/**
 * Turns one fetched file into normalized text plus its heading structure.
 *
 * The heading structure is not decoration: a citation has to name the section a
 * quote came from (requirement.md 8.1, "create citations"), and the only place
 * that information exists is the document's own headings.
 */
export function parseDocument(input: {
  path: string;
  format: DocumentFormat;
  content: string;
  /**
   * The title the page declares apart from its content -- a renderer's
   * metadata, or the `<title>` of the shell a rendered page was fetched as.
   * An HTML document's own `<title>` is read here and needs no passing.
   */
  pageTitle?: string | null;
  /** The site's name, so a declared title can shed its "| Site" suffix. */
  siteTitle?: string | null;
  fallbackTitle?: string;
}): ParsedDocument {
  const raw =
    input.format === 'html'
      ? htmlToText(input.content)
      : input.format === 'structured'
        ? structuredToText(input.content)
        : input.content;

  const body = normalizeText(raw);
  const sections = headingsOf(body);
  /*
   * The author's level-1 heading first; failing that, what the page says it
   * is called -- before any lower heading, because the first `##` of a page
   * with no `#` is a card or a column, not the page. A rendered pricing page
   * whose markdown opened with "## Free" was titled "Free" that way.
   */
  const declared = cleanPageTitle(
    input.pageTitle ?? (input.format === 'html' ? htmlTitle(input.content) : null),
    input.siteTitle,
  );
  const title =
    sections.find((section) => section.level === 1)?.heading ??
    declared ??
    sections[0]?.heading ??
    input.fallbackTitle ??
    fileTitle(input.path);

  return { path: input.path, title, body, sections };
}

/** The `<title>` of an HTML document, or null when it has none worth the name. */
export function htmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const text = decodeEntities(stripTags(match[1] ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

/** The separators sites put between a page's name and their own. */
const TITLE_SEPARATOR = /\s+(?:\||-|–|—|·|•|::|»)\s+/;

/**
 * A declared title without its site suffix: "Pricing | APAGE" is "Pricing"
 * on a site called APAGE. Only the site's own name is stripped, compared
 * without case, so a title that merely contains a separator is left whole;
 * and a title that *is* the site name (the home page) stays as it is.
 */
export function cleanPageTitle(
  title: string | null | undefined,
  siteTitle?: string | null,
): string | null {
  const text = (title ?? '').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  const site = (siteTitle ?? '').trim().toLowerCase();
  if (site.length === 0) return text;
  const parts = text.split(TITLE_SEPARATOR);
  if (parts.length < 2) return text;
  const last = parts[parts.length - 1]!.trim().toLowerCase();
  const first = parts[0]!.trim().toLowerCase();
  if (last === site) {
    const kept = parts.slice(0, -1).join(' | ').trim();
    return kept.length > 0 ? kept : text;
  }
  if (first === site) {
    const kept = parts.slice(1).join(' | ').trim();
    return kept.length > 0 ? kept : text;
  }
  return text;
}

const NBSP = String.fromCharCode(0x00a0);

/** Collapses line endings, trailing space and runs of blank lines. */
export function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split(NBSP)
    .join(' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * HTML to text, without a parser dependency.
 *
 * Script, style, nav and footer content is removed rather than flattened: a
 * site's navigation appears on every page, and chunking it once per page would
 * fill a library with hundreds of near-identical chunks that match every query
 * about the site and answer none of them.
 */
/**
 * Whether an HTML page is an application shell -- markup that a browser
 * would turn into content and a plain fetch cannot.
 *
 * The tell is the combination: scripts present, text absent. A page with no
 * scripts and little text is simply a short page; a page with scripts and
 * plenty of text was rendered on the server. Only the pair means the content
 * is still on the client. Kept as a rule here rather than a threshold in the
 * connector so the failure it produces (`source_unrendered`) means one thing
 * everywhere it is reported.
 */
const SHELL_TEXT_CHARS = 300;

export function isRenderedShell(html: string): boolean {
  if (!/<script\b/i.test(html)) return false;
  return htmlToText(html).trim().length < SHELL_TEXT_CHARS;
}

export function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

  const withHeadings = withoutNoise
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level: string, inner: string) =>
      `\n\n${'#'.repeat(Number(level))} ${stripTags(inner).trim()}\n\n`,
    )
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|tr|ul|ol|pre|table)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n');

  return decodeEntities(stripTags(withHeadings));
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/[ \t]{2,}/g, ' ');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, name: string) => {
    const known = lookup(ENTITIES, name.toLowerCase());
    if (known !== null) return known;
    if (/^#x/i.test(name)) {
      return codePointText(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith('#')) {
      return codePointText(Number.parseInt(name.slice(1), 10));
    }
    return all;
  });
}

/**
 * A numeric character reference, decoded defensively: `String.fromCodePoint`
 * throws on anything past U+10FFFF or in the surrogate range, and one
 * malformed entity must not fail a whole build. Invalid references become a
 * space, the same fallback an unparsable one gets.
 */
function codePointText(point: number): string {
  if (!Number.isFinite(point) || point <= 0 || point > 0x10ffff) return ' ';
  if (point >= 0xd800 && point <= 0xdfff) return ' ';
  return String.fromCodePoint(point);
}

/**
 * A JSON document rendered as readable text.
 *
 * An API description committed to a repository is the case that matters, and
 * what a reader wants from one is the paths, the operations and their
 * descriptions -- not the JSON. A spec is therefore flattened into
 * `path: value` lines under headings, which chunk and cite sensibly. Anything
 * that is not recognisable JSON is left as it arrived, because YAML with its
 * own indentation already reads as text.
 */
export function structuredToText(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }

  const lines: string[] = [];
  const walk = (node: unknown, trail: string, depth: number): void => {
    if (depth > 12 || lines.length > 20_000) return;
    if (node === null || typeof node !== 'object') {
      if (trail) lines.push(`${trail}: ${String(node)}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${trail}[${index}]`, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const next = trail ? `${trail}.${key}` : key;
      if (value !== null && typeof value === 'object') {
        lines.push(`\n## ${next}`);
        walk(value, next, depth + 1);
      } else {
        lines.push(`${next}: ${String(value)}`);
      }
    }
  };
  walk(parsed, '', 0);
  return lines.join('\n');
}

function fileTitle(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  return stem.replace(/[-_]+/g, ' ').trim() || path;
}

function headingsOf(body: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  let offset = 0;
  for (const line of body.split('\n')) {
    const match = HEADING.exec(line);
    if (match) {
      sections.push({
        offset,
        level: (match[1] ?? '#').length,
        heading: (match[2] ?? '').trim(),
      });
    }
    offset += line.length + 1;
  }
  return sections;
}

/* ---------------------------------------------------------------- chunking */

/**
 * A rough token count.
 *
 * Deliberately provider-independent: `chunk.tokens` feeds `maxTokens` trimming
 * and the capacity figures in requirement.md 4.1, both of which need a number
 * that is stable across embedding providers rather than one that is exactly
 * right for whichever model is configured this month. Four characters per token
 * is the usual approximation for prose and code; CJK text is far denser, so it
 * is counted per character instead of being underestimated threefold.
 */
export function estimateTokens(value: string): number {
  let dense = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x2e80 && code <= 0xd7ff) || (code >= 0xf900 && code <= 0xfaff)) dense += 1;
  }
  const rest = Math.max(0, [...value].length - dense);
  return Math.ceil(rest / 4) + dense;
}

export const CHUNK_TARGET_TOKENS = 400;
export const CHUNK_MAX_TOKENS = 800;
export const CHUNK_OVERLAP_TOKENS = 40;

export interface DraftChunk {
  ordinal: number;
  body: string;
  tokens: number;
  /** Heading trail the chunk sits under, most general first. */
  headings: string[];
}

interface Block {
  text: string;
  heading: string | null;
  level: number;
}

/**
 * Splits one document into chunks on structure first, size second.
 *
 * Headings are the split points because they are the author's own statement of
 * where one topic ends. Only when a single section is still too big does this
 * fall back to line boundaries -- and fenced code blocks are never split, since
 * half of a code sample is not a smaller sample but a wrong one, and returning
 * it with a citation would make it look checked.
 */
export function chunkDocument(document: ParsedDocument): DraftChunk[] {
  const blocks = splitBlocks(document.body);
  const chunks: DraftChunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let headings: string[] = [];
  let bufferHeadings: string[] = [];

  const flush = (): void => {
    const body = buffer.join('\n\n').trim();
    buffer = [];
    bufferTokens = 0;
    if (body.length === 0) return;
    chunks.push({
      ordinal: chunks.length,
      body,
      tokens: estimateTokens(body),
      headings: bufferHeadings.filter((entry) => typeof entry === 'string' && entry.length > 0),
    });
  };

  for (const block of blocks) {
    if (block.heading) {
      // A heading of the same or a broader level ends the previous section.
      flush();
      headings = headings.slice(0, block.level - 1);
      headings[block.level - 1] = block.heading;
      bufferHeadings = [...headings];
    }
    if (buffer.length === 0) bufferHeadings = [...headings];

    for (const piece of fitBlock(block.text)) {
      const tokens = estimateTokens(piece);
      if (bufferTokens > 0 && bufferTokens + tokens > CHUNK_TARGET_TOKENS) {
        const tail = buffer.at(-1);
        flush();
        bufferHeadings = [...headings];
        /*
         * Carry the last paragraph forward so a definition and the sentence
         * that uses it are not separated by a boundary neither side mentions.
         */
        if (tail && estimateTokens(tail) <= CHUNK_OVERLAP_TOKENS) {
          buffer.push(tail);
          bufferTokens += estimateTokens(tail);
        }
      }
      buffer.push(piece);
      bufferTokens += tokens;
    }
  }
  flush();

  return chunks.slice(0, INGESTION_LIMITS.maxChunks).map((chunk, ordinal) => ({ ...chunk, ordinal }));
}

/** Paragraphs and fenced code blocks, with headings marked. */
function splitBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let fence: string | null = null;

  const endParagraph = (): void => {
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (text.length > 0) blocks.push({ text, heading: null, level: 0 });
  };

  for (const line of body.split('\n')) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? '```').slice(0, 3);
      if (fence === null) {
        endParagraph();
        fence = marker;
        paragraph.push(line);
        continue;
      }
      if (line.trimStart().startsWith(fence)) {
        paragraph.push(line);
        blocks.push({ text: paragraph.join('\n'), heading: null, level: 0 });
        paragraph = [];
        fence = null;
        continue;
      }
    }
    if (fence !== null) {
      paragraph.push(line);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({
        text: line.trim(),
        heading: (heading[2] ?? '').trim(),
        level: (heading[1] ?? '#').length,
      });
      continue;
    }
    if (line.trim().length === 0) {
      endParagraph();
      continue;
    }
    paragraph.push(line);
  }
  /* An unterminated fence is still content; it must not be dropped. */
  endParagraph();
  return blocks;
}

/**
 * Cuts a single over-long block on line boundaries, as a last resort.
 *
 * A fenced code block that is itself larger than one chunk has to be cut
 * somewhere -- an unbounded chunk exceeds what an embedding call accepts and
 * retrieves as one undifferentiated wall -- so each piece is re-fenced with the
 * original marker and language. That keeps the property that matters: no chunk
 * ever contains half a fence, and every piece is still valid, runnable-looking
 * code rather than a fragment that begins mid-block with no marker at all.
 */
function fitBlock(text: string): string[] {
  if (estimateTokens(text) <= CHUNK_MAX_TOKENS) return [text];

  const lines = text.split('\n');
  const opening = /^\s*(?:`{3,}|~{3,})/.test(lines[0] ?? '') ? (lines[0] as string) : null;
  const closing = opening && /^\s*(?:`{3,}|~{3,})\s*$/.test(lines.at(-1) ?? '')
    ? (lines.at(-1) as string)
    : null;
  const body = opening && closing ? lines.slice(1, -1) : lines;

  /* Re-fencing costs tokens on every piece, so the body's budget is what is
     left after the markers -- otherwise each piece lands just over the max. */
  const limit =
    opening && closing
      ? Math.max(1, CHUNK_MAX_TOKENS - estimateTokens(`${opening}\n\n${closing}`))
      : CHUNK_MAX_TOKENS;

  const pieces: string[] = [];
  let current: string[] = [];
  let tokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const joined = current.join('\n');
    pieces.push(opening && closing ? `${opening}\n${joined}\n${closing}` : joined);
    current = [];
    tokens = 0;
  };

  for (const line of body) {
    /*
     * A line can be longer than a whole chunk on its own -- a CJK paragraph
     * with no breaks, a minified bundle, a flattened OpenAPI description --
     * and the `tokens > 0` guard below always admits the first line of a
     * piece whatever its size. So the line is cut first: without this the
     * function returned the very thing its name promises to prevent, and the
     * oversized chunk went on to fail the embedding call and, with it, the
     * whole build of a source that was merely badly wrapped.
     */
    for (const part of splitLine(line, limit)) {
      const partTokens = estimateTokens(part);
      if (tokens > 0 && tokens + partTokens > limit) flush();
      current.push(part);
      tokens += partTokens;
    }
  }
  flush();
  return pieces;
}

/**
 * One line as pieces no larger than a chunk, cut at the last space before the
 * limit and mid-word only when there is no space to cut at -- which is the
 * normal case for CJK, where every character is its own word.
 */
function splitLine(line: string, limit: number): string[] {
  if (estimateTokens(line) <= limit) return [line];

  const parts: string[] = [];
  /* By code point: an astral character must not be cut in half. */
  const chars = Array.from(line);
  let start = 0;
  let dense = 0;
  let rest = 0;
  let lastSpace = -1;

  /* `estimateTokens`, accumulated as we go: measuring each candidate prefix
     instead would make cutting a one-megabyte line quadratic. */
  const cost = (): number => Math.ceil(rest / 4) + dense;

  for (let at = 0; at < chars.length; at += 1) {
    const character = chars[at] as string;
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x2e80 && code <= 0xd7ff) || (code >= 0xf900 && code <= 0xfaff)) dense += 1;
    else rest += 1;
    if (character === ' ') lastSpace = at;

    if (cost() < limit) continue;

    /* At a word boundary where there is one, mid-word where there is not --
       which is the normal case for CJK, where every character is its own word. */
    const cut = lastSpace > start ? lastSpace + 1 : at + 1;
    parts.push(chars.slice(start, cut).join(''));
    start = cut;
    at = cut - 1;
    dense = 0;
    rest = 0;
    lastSpace = -1;
  }

  if (start < chars.length) parts.push(chars.slice(start).join(''));
  return parts;
}

/**
 * The citation stored on a chunk. requirement.md 8.1.
 *
 * Everything a reader needs to go and check the claim themselves: which
 * document, which section of it, and the URL that document is served at.
 */
export interface Citation extends Record<string, unknown> {
  title: string;
  url: string;
  section: string | null;
  path: string;
  /** 'faq' for a chunk of an owner-written FAQ entry (lib/domain/faq.ts); absent for a page of the source. */
  kind?: 'faq';
}

const SECTION_SEPARATOR = ' > ';

export function citationFor(input: {
  document: ParsedDocument;
  sourceUrl: string;
  headings: string[];
}): Citation {
  const section = input.headings.filter(Boolean).join(SECTION_SEPARATOR);
  return {
    title: input.document.title,
    url: input.sourceUrl,
    section: section.length > 0 ? section : null,
    path: input.document.path,
  };
}

/* ----------------------------------------------------------------- digests */

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return hex(new Uint8Array(digest));
}

/**
 * The digest that decides whether a refresh has anything to do.
 *
 * Computed over the sorted list of `path digest` pairs, so it changes when a
 * file's content changes, when one appears or disappears, and when one is
 * renamed -- and not when the same files come back from the network in a
 * different order. architecture.md 8.4 turns an unchanged digest into "update
 * `last_checked_at` and stop", so a digest that moved for an irrelevant reason
 * would mean a rebuild and a new version for no change at all.
 */
export async function snapshotDigest(
  entries: readonly { path: string; content: string }[],
): Promise<string> {
  const lines = await Promise.all(
    [...entries]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map(async (entry) => `${entry.path} ${await sha256Hex(entry.content)}`),
  );
  return sha256Hex(lines.join('\n'));
}

/**
 * A Merkle root over ordered chunk digests. `library_version.content_merkle_root`.
 *
 * Leaves and interior nodes are domain-separated with a `L:` / `N:` prefix, the
 * standard defence against presenting an interior node as a leaf. An odd node
 * is carried up unchanged rather than duplicated, which is the other half of
 * that defence: duplicating the last leaf lets two different chunk lists
 * produce the same root.
 */
export async function merkleRoot(leaves: readonly string[]): Promise<string | null> {
  if (leaves.length === 0) return null;

  let level = await Promise.all(leaves.map((leaf) => sha256Hex(`L:${leaf}`)));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as string;
      const right = level[i + 1];
      next.push(right === undefined ? left : await sha256Hex(`N:${left}${right}`));
    }
    level = next;
  }
  return level[0] ?? null;
}

/**
 * A version label a person can read, derived from the digest it froze.
 *
 * `sequence` disambiguates rebuilds of an unchanged source. Those became
 * possible once a build compares the parser, chunker, embedding model and
 * search configuration as well as the digest: correcting a library's language
 * rebuilds the same bytes under a different configuration, and two rows reading
 * `20260831-8e0734c3` in the console's version list would be indistinguishable
 * to the operator choosing between them.
 *
 * The first build of a digest keeps the bare label, so the common case is
 * unchanged and no existing label has to move.
 */
export function versionLabel(digest: string, at: Date, sequence = 1): string {
  const stamp = at.toISOString().slice(0, 10).replace(/-/g, '');
  const base = `${stamp}-${digest.slice(0, 8)}`;
  return sequence > 1 ? `${base}.${sequence}` : base;
}

/* ------------------------------------------------------- text search config */

/**
 * The Postgres text-search configurations `chunk.search_vector` may be built
 * with -- every stemmer a stock Postgres ships, plus `simple`.
 *
 * This list is load-bearing twice over. `chunk.search_config` is constrained to
 * it, and the generated column has one `CASE` branch per entry; a value that
 * passed the constraint but had no branch would produce a NULL vector, which is
 * a chunk that exists and can never be found. `tests/contract/ingestion.test.ts`
 * reads the migration and checks the two agree.
 *
 * No Chinese, Japanese or Korean configuration appears here because stock
 * Postgres has none -- they need a segmenter extension (`zhparser`, `pg_jieba`)
 * that a managed Postgres will not install. CJK text therefore falls back to
 * `simple`, which does not segment: an entire run of Han characters becomes one
 * token, so only an exact match on the whole run hits it. Keyword retrieval is
 * effectively unavailable for those libraries and the vector half carries them.
 * Pretending otherwise by picking a European stemmer would be worse.
 */
export const TEXT_SEARCH_CONFIGS = [
  'simple',
  'arabic',
  'armenian',
  'basque',
  'catalan',
  'danish',
  'dutch',
  'english',
  'finnish',
  'french',
  'german',
  'greek',
  'hindi',
  'hungarian',
  'indonesian',
  'irish',
  'italian',
  'lithuanian',
  'nepali',
  'norwegian',
  'portuguese',
  'romanian',
  'russian',
  'serbian',
  'spanish',
  'swedish',
  'tamil',
  'turkish',
  'yiddish',
] as const;

export type TextSearchConfig = (typeof TEXT_SEARCH_CONFIGS)[number];

export function isTextSearchConfig(value: unknown): value is TextSearchConfig {
  return typeof value === 'string' && (TEXT_SEARCH_CONFIGS as readonly string[]).includes(value);
}

/**
 * What an operator might have typed into `library.language`, and what it means.
 *
 * The column is free text (requirement.md 6.1 lists a language, not a code), so
 * this accepts the three things people actually write: an ISO 639-1 code, the
 * English name, and the language's own name. Anything else falls through to
 * `simple`, which indexes without stemming -- worse recall, never wrong
 * results, which is the right way round for a guess.
 */
const LANGUAGE_ALIASES: Record<string, TextSearchConfig> = {
  ar: 'arabic',
  arabic: 'arabic',
  hy: 'armenian',
  armenian: 'armenian',
  eu: 'basque',
  basque: 'basque',
  ca: 'catalan',
  catalan: 'catalan',
  da: 'danish',
  danish: 'danish',
  dansk: 'danish',
  nl: 'dutch',
  dutch: 'dutch',
  nederlands: 'dutch',
  en: 'english',
  english: 'english',
  fi: 'finnish',
  finnish: 'finnish',
  suomi: 'finnish',
  fr: 'french',
  french: 'french',
  'francais': 'french',
  de: 'german',
  german: 'german',
  deutsch: 'german',
  el: 'greek',
  greek: 'greek',
  hi: 'hindi',
  hindi: 'hindi',
  hu: 'hungarian',
  hungarian: 'hungarian',
  magyar: 'hungarian',
  id: 'indonesian',
  indonesian: 'indonesian',
  ga: 'irish',
  irish: 'irish',
  it: 'italian',
  italian: 'italian',
  italiano: 'italian',
  lt: 'lithuanian',
  lithuanian: 'lithuanian',
  ne: 'nepali',
  nepali: 'nepali',
  nb: 'norwegian',
  nn: 'norwegian',
  no: 'norwegian',
  norwegian: 'norwegian',
  norsk: 'norwegian',
  pt: 'portuguese',
  portuguese: 'portuguese',
  'portugues': 'portuguese',
  ro: 'romanian',
  romanian: 'romanian',
  ru: 'russian',
  russian: 'russian',
  sr: 'serbian',
  serbian: 'serbian',
  es: 'spanish',
  spanish: 'spanish',
  'espanol': 'spanish',
  castellano: 'spanish',
  sv: 'swedish',
  swedish: 'swedish',
  svenska: 'swedish',
  ta: 'tamil',
  tamil: 'tamil',
  tr: 'turkish',
  turkish: 'turkish',
  'turkce': 'turkish',
  yi: 'yiddish',
  yiddish: 'yiddish',
};

/**
 * The configuration one library's chunks are indexed with.
 *
 * Resolved once per build and stored on every chunk it writes, rather than
 * looked up at query time. Two reasons: a generated column cannot read another
 * table, and -- more importantly -- editing `library.language` afterwards must
 * not silently change what an already published Version means. Chunks are
 * immutable (requirement.md 8.1); the new language takes effect on the next
 * build, and until then `chunk.search_config` is an accurate record of how the
 * rows that exist were actually indexed.
 */
export function textSearchConfig(language: string | null | undefined): TextSearchConfig {
  const raw = (language ?? '').trim().toLowerCase();
  if (raw.length === 0) return 'simple';

  /* `en-US`, `pt_BR` and `zh-Hans` all decide on their first subtag. */
  const primary = raw.split(/[-_\s,/]/)[0] ?? '';
  const folded = fold(primary);

  return lookup(LANGUAGE_ALIASES, folded) ?? lookup(LANGUAGE_ALIASES, fold(raw)) ?? 'simple';
}

/**
 * Strips the accents an endonym is usually written with.
 *
 * `Français` and `francais` are the same answer, and an operator typing either
 * should not get a different index from the other.
 */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/* ----------------------------------------------------------------- scoring */

/**
 * Bumped whenever a score's inputs or weights change. requirement.md 6.3.
 *
 * -3: the Benchmark is structural again -- what a build can count. -2 had
 * blended in the hit rate of a library's test set; the self-check questions
 * went with the expert-library programme (agent-first-proposal.md 3.6).
 */
export const SCORE_ALGORITHM_VERSION = 're0-score-3';

export interface ScoreInputs {
  /** True for a source whose control has been verified. */
  verified: boolean;
  isPlatformLibrary: boolean;
  documents: number;
  chunks: number;
  /** Chunks whose body repeats another chunk's, over total chunks. */
  duplicateRatio: number;
  /** Chunks that carry a section in their citation, over total chunks. */
  citedRatio: number;
  flaggedChunks: number;
  /** Days since the source last changed. */
  ageDays: number;
  hasLicense: boolean;
}

/**
 * Trust and Benchmark, 0-100. requirement.md 6.3.
 *
 * Trust is about the *source*: who it is, whether we can tell, whether it is
 * still maintained, and whether it is licensed to be republished. Benchmark is
 * about the *build*: coverage, citation completeness and duplication -- what
 * a build can count. They are separate numbers because a well-maintained
 * repository can produce a poor index and an abandoned one can produce an
 * excellent index, and collapsing them would hide both cases.
 *
 * These are heuristics over what a build actually knows, and they are versioned
 * (`SCORE_ALGORITHM_VERSION`) precisely because they will be replaced by better
 * ones. requirement.md 6.3 forbids presenting either as a guarantee.
 */
export function scoreLibrary(input: ScoreInputs): { trust: number; benchmark: number } {
  let trust = 40;
  /*
   * The platform is the identified publisher of its own libraries, which is
   * the question Trust asks -- not a claim about the content.
   */
  if (input.isPlatformLibrary) trust += 25;
  if (input.verified) trust += 15;
  if (input.hasLicense) trust += 10;
  if (input.ageDays <= 30) trust += 10;
  else if (input.ageDays <= 180) trust += 5;
  else if (input.ageDays > 730) trust -= 10;
  if (input.flaggedChunks > 0) trust -= Math.min(15, input.flaggedChunks);

  let benchmark = 20;
  benchmark += Math.min(25, Math.round(Math.log10(Math.max(1, input.documents)) * 18));
  benchmark += Math.min(25, Math.round(Math.log10(Math.max(1, input.chunks)) * 12));
  benchmark += Math.round(input.citedRatio * 30);
  benchmark -= Math.round(input.duplicateRatio * 40);

  return { trust: clamp(trust), benchmark: clamp(benchmark) };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
