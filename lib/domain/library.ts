/**
 * Platform library rules, as pure functions. No Next.js, no driver, no fetch.
 *
 * A platform library is one re0 publishes itself: requirement.md 5.3 gives
 * the console four verbs over it -- create, refresh, suspend and publish -- and
 * nothing else. The distinction from a user library is not cosmetic:
 *
 * - it has no `owner_workspace_id`, and must never acquire one. Ownership is
 *   written only by a verified claim or an admin ruling (architecture.md 5.4),
 *   and a library the platform publishes has no claimant;
 * - it does not take part in revenue share (requirement.md 4.4), precisely
 *   because it has no owner to pay;
 * - it skips public review. The review queue exists to decide whether a
 *   stranger's library may be public (architecture.md 8.2, `Evaluating -->
 *   Publishing: private or platform library`), which is not a question about
 *   our own, so its lifecycle never passes through `submitted` or `reviewing`.
 *
 * Everything here decides whether a proposed change is allowed at all, so the
 * console, the tests and any future admin API answer the same way.
 */

import type { IndexStatus, LifecycleStatus, Visibility } from '@/lib/domain';
import { requiresDomainVerification } from './domain-verification';
import { uuidv7 } from './id';

/* ------------------------------------------------------------------ sources */

/**
 * The source types a platform library may be created from.
 *
 * Narrower than the `source_type` enum on purpose. `markdown` and `pdf` are
 * uploads -- they arrive through object storage, not through a location an
 * operator can type -- so a console form that offered them would be offering a
 * library that can never fetch anything.
 */
export const PLATFORM_SOURCE_TYPES = ['github', 'website', 'llms_txt', 'openapi', 'notion'] as const;

export type PlatformSourceType = (typeof PLATFORM_SOURCE_TYPES)[number];

export function isPlatformSourceType(value: unknown): value is PlatformSourceType {
  return typeof value === 'string' && (PLATFORM_SOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * The source types a platform library may be *created* as: the typed ones
 * above plus `pdf`, whose files the console uploads to object storage in the
 * create dialog and manages from the library's files panel afterwards. A
 * `pdf` source is never added to a library or edited as a location -- its
 * location is the upload prefix, derived rather than typed -- which is why it
 * is in this set and not in `PLATFORM_SOURCE_TYPES`.
 */
export const PLATFORM_LIBRARY_TYPES = [...PLATFORM_SOURCE_TYPES, 'pdf'] as const;

export type PlatformLibraryType = (typeof PLATFORM_LIBRARY_TYPES)[number];

export function isPlatformLibraryType(value: unknown): value is PlatformLibraryType {
  return typeof value === 'string' && (PLATFORM_LIBRARY_TYPES as readonly string[]).includes(value);
}

/**
 * Every source type that has a connector, which is what a build can ingest.
 *
 * The platform set plus the two upload types: a workspace uploads its PDFs
 * or Markdown/MDX files through the dashboard wizard (requirement.md 6.1
 * reserves `/docs/slug` for uploaded material), and the connector reads them
 * back from object storage at build time.
 */
export const CONNECTED_SOURCE_TYPES = [...PLATFORM_SOURCE_TYPES, 'pdf', 'markdown'] as const;

export type ConnectedSourceType = (typeof CONNECTED_SOURCE_TYPES)[number];

export function isConnectedSourceType(value: unknown): value is ConnectedSourceType {
  return typeof value === 'string' && (CONNECTED_SOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * The source types a workspace fills by uploading files rather than by naming
 * a location: PDFs, and Markdown/MDX documents (requirement.md 5.2 lists both
 * as first-release sources). Both keep their files on `source.config.files`
 * and share the ticket, manifest and files-page flow; only the bytes differ.
 */
export const UPLOAD_SOURCE_TYPES = ['pdf', 'markdown'] as const;

export type UploadSourceType = (typeof UPLOAD_SOURCE_TYPES)[number];

export function isUploadSourceType(value: unknown): value is UploadSourceType {
  return typeof value === 'string' && (UPLOAD_SOURCE_TYPES as readonly string[]).includes(value);
}

/** What an upload of each kind is sent and stored as. */
export const UPLOAD_CONTENT_TYPES: Record<UploadSourceType, string> = {
  pdf: 'application/pdf',
  markdown: 'text/markdown',
};

/** The file extensions an upload of each kind may carry; the first is the default. */
export const UPLOAD_EXTENSIONS: Record<UploadSourceType, readonly string[]> = {
  pdf: ['pdf'],
  markdown: ['md', 'mdx'],
};

/* ----------------------------------------------------------------- uploads */

/**
 * What one uploaded file looks like on `source.config.files` for a `pdf`
 * source. The key is where the bytes sit in object storage; the name is what
 * the operator called it and is only ever shown, never used as a key.
 */
export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  key: string;
}

export const UPLOAD_LIMITS = {
  /**
   * Per file. A manual, a report or a scanned booklet; an archive is not a
   * library. Uploads go straight to the object store, so the app's request
   * body limit plays no part; what bounds this is what one build should read
   * back into memory, and what an OCR provider will accept (`ocr.ts`).
   */
  maxFileBytes: 30 * 1024 * 1024,
  /** Per library creation. */
  maxFiles: 20,
  /** Presigned upload URLs stop working after this many seconds. */
  uploadUrlTtlSeconds: 15 * 60,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The object key of one uploaded file. Built from ids only (architecture.md 7
 * keeps user input out of keys), and rooted in the workspace so that a
 * create request can only ever reference uploads the same workspace
 * prepared: a key that does not start with the caller's workspace prefix is
 * refused before the store is asked anything.
 */
export function uploadKey(
  owner: string,
  batchId: string,
  fileId: string,
  kind: UploadSourceType = 'pdf',
): string {
  return `${uploadPrefix(owner, batchId)}/${fileId}.${UPLOAD_EXTENSIONS[kind][0]}`;
}

/**
 * The owner segment of a platform library's uploads. Platform libraries have
 * no workspace (architecture.md 5.4), and their PDFs are uploaded from the
 * console, so this word takes the workspace id's place in the key -- one
 * prefix the console may reference and no workspace ever can, since a
 * workspace id is a UUID.
 */
export const PLATFORM_UPLOAD_OWNER = 'platform';

/** `owner` is a workspace id, or `PLATFORM_UPLOAD_OWNER` for the console's uploads. */
export function uploadPrefix(owner: string, batchId: string): string {
  return `uploads/${owner}/${batchId}`;
}

/**
 * A file name fit to show and to cite: no path, no control characters, and
 * an extension of the kind being uploaded -- the build parses by extension
 * (`documentFormat`), so a Markdown file has to end in `.md` or `.mdx`.
 */
export function uploadFileName(name: string, kind: UploadSourceType = 'pdf'): string | null {
  const base = name
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (base.length === 0 || base.length > 200) return null;
  const extensions = UPLOAD_EXTENSIONS[kind];
  const lower = base.toLowerCase();
  return extensions.some((extension) => lower.endsWith(`.${extension}`))
    ? base
    : `${base}.${extensions[0]}`;
}

/**
 * The manifest a create or update request carries, checked field by field:
 * the shape came from a form post, so nothing about it is trusted. Every key
 * must sit under this workspace's prefix for this batch; anything else is
 * refused as a whole rather than filtered, because a manifest with a foreign
 * key in it was not produced by the wizard.
 *
 * An empty file list is a valid manifest: a PDF library may be created
 * before its files exist, and filled in from the library's files page.
 */
export function parseUploadManifest(
  value: unknown,
  owner: string,
  kind: UploadSourceType = 'pdf',
): { batchId: string; files: UploadedFile[] } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { batchId, files } = value as { batchId?: unknown; files?: unknown };
  if (typeof batchId !== 'string' || !UUID.test(batchId)) return null;
  if (!Array.isArray(files) || files.length > UPLOAD_LIMITS.maxFiles) return null;
  const seen = new Set<string>();
  const parsed: UploadedFile[] = [];
  for (const file of files as unknown[]) {
    if (typeof file !== 'object' || file === null) return null;
    const { id, name, size } = file as { id?: unknown; name?: unknown; size?: unknown };
    if (typeof id !== 'string' || !UUID.test(id) || seen.has(id)) return null;
    if (typeof name !== 'string') return null;
    const fileName = uploadFileName(name, kind);
    if (!fileName) return null;
    if (
      typeof size !== 'number' ||
      !Number.isInteger(size) ||
      size <= 0 ||
      size > UPLOAD_LIMITS.maxFileBytes
    ) {
      return null;
    }
    seen.add(id);
    parsed.push({ id, name: fileName, size, key: uploadKey(owner, batchId, id, kind) });
  }
  return { batchId, files: parsed };
}

/**
 * The file list of a `pdf` source after an edit: what it had, minus the ids
 * being removed, plus the files a fresh manifest confirmed. Pure, so the
 * ceiling and the duplicate rule are the same whether the caller is the
 * dashboard or a test. Null when the edit is not one the source can take: a
 * removal of a file it does not list, an addition it already lists, or more
 * files than one library may hold.
 */
export function mergeUploadedFiles(
  current: readonly UploadedFile[],
  added: readonly UploadedFile[],
  removedIds: readonly string[],
): UploadedFile[] | null {
  const known = new Set(current.map((file) => file.id));
  const removed = new Set<string>();
  for (const id of removedIds) {
    if (!known.has(id) || removed.has(id)) return null;
    removed.add(id);
  }
  for (const file of added) {
    if (known.has(file.id)) return null;
  }
  const merged = [...current.filter((file) => !removed.has(file.id)), ...added];
  return merged.length > UPLOAD_LIMITS.maxFiles ? null : merged;
}

/**
 * How long an upload may sit unreferenced before it counts as abandoned. A
 * wizard session that is still going has objects younger than this; an upload
 * token lives fifteen minutes, so anything a day old was never followed by a
 * create request that succeeded.
 */
export const ABANDONED_UPLOAD_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Which objects under `uploads/` are nobody's: older than the grace period
 * and listed by no `pdf` source. An object whose age the store does not
 * report is kept -- deleting on a guess is the wrong side to err on.
 */
export function abandonedUploadKeys(
  objects: readonly { key: string; uploadedAt: Date | null }[],
  referenced: ReadonlySet<string>,
  now: number,
  maxAgeMs: number = ABANDONED_UPLOAD_AGE_MS,
): string[] {
  return objects
    .filter(
      (object) =>
        object.uploadedAt !== null &&
        now - object.uploadedAt.getTime() > maxAgeMs &&
        !referenced.has(object.key),
    )
    .map((object) => object.key);
}

/** The files a `pdf` source's stored config lists, or none if it is malformed. */
export function uploadedFilesOf(config: Record<string, unknown>): UploadedFile[] {
  const files = config.files;
  if (!Array.isArray(files)) return [];
  return files.filter(
    (file): file is UploadedFile =>
      typeof file === 'object' &&
      file !== null &&
      typeof (file as UploadedFile).id === 'string' &&
      typeof (file as UploadedFile).name === 'string' &&
      typeof (file as UploadedFile).size === 'number' &&
      typeof (file as UploadedFile).key === 'string',
  );
}

/**
 * How often the ingestion side should re-check the source.
 *
 * Stored on `source.refresh_policy`, which is free-form JSON; these are the
 * three cadences the console offers, so the column holds a value the refresh
 * worker can act on rather than whatever a form happened to post.
 */
export const REFRESH_POLICIES = ['daily', 'weekly', 'manual'] as const;

export type RefreshPolicy = (typeof REFRESH_POLICIES)[number];

export function isRefreshPolicy(value: unknown): value is RefreshPolicy {
  return typeof value === 'string' && (REFRESH_POLICIES as readonly string[]).includes(value);
}

/**
 * How long a source is left alone after a check before it is checked again.
 *
 * `manual` has no interval: the operator is the schedule. The two timed
 * cadences are read by the scheduled drain (architecture.md 8.4), which queues
 * a refresh for every source whose last check is older than this.
 */
export const REFRESH_INTERVALS_MS: Record<Exclude<RefreshPolicy, 'manual'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/**
 * When a source is next due, or null when it is only refreshed by hand.
 *
 * A timed source that has never been checked is due at once: a daily policy on
 * a library nobody has refreshed yet is a request for the first build, not for
 * one tomorrow. That is expressed as the epoch, so "due at or before now" is
 * one comparison for the scheduler and one for the screen.
 */
export function refreshDueAt(policy: RefreshPolicy | 'unknown', lastCheckedAt: Date | null): Date | null {
  if (policy === 'manual' || policy === 'unknown') return null;
  if (!lastCheckedAt) return new Date(0);
  return new Date(lastCheckedAt.getTime() + REFRESH_INTERVALS_MS[policy]);
}

/* -------------------------------------------------------------- library ids */

/**
 * The Library ID namespace each source type publishes under. requirement.md 6.1
 * fixes four shapes and this is the whole mapping:
 *
 * - a Git repository is `/owner/repository`;
 * - a crawled site, and the `llms.txt` that describes one, are `/websites/slug`;
 * - a Notion space is `/notion/slug`;
 * - anything else the platform assembles -- an OpenAPI document included -- is
 *   `/docs/slug`, the namespace requirement.md reserves for uploaded material.
 *
 * The three slug namespaces nest: `/websites/ethereum/whitepaper` is a library
 * of its own, grouped under `/websites/ethereum` in the catalogue. A repository
 * id is always exactly `/owner/repository`, because its third segment has
 * meant "version" since requirement.md 6.1 -- and for the nested namespaces a
 * trailing segment still can: `libraryIdCandidates` below says how the two
 * readings are told apart.
 */
const ID_NAMESPACE: Record<ConnectedSourceType, 'repository' | 'websites' | 'notion' | 'docs'> = {
  github: 'repository',
  website: 'websites',
  llms_txt: 'websites',
  openapi: 'docs',
  notion: 'notion',
  pdf: 'docs',
  markdown: 'docs',
};

/** The raw id namespace a non-repository source publishes under. */
export function idNamespace(type: ConnectedSourceType): 'repository' | 'websites' | 'notion' | 'docs' {
  return ID_NAMESPACE[type];
}

export function namespaceFor(type: ConnectedSourceType): string {
  const namespace = ID_NAMESPACE[type];
  return namespace === 'repository' ? '/owner/repository' : `/${namespace}/slug`;
}

/**
 * A slug segment: lowercase, and only the characters that survive a URL path
 * unescaped. Case is folded rather than rejected because `/websites/NextJS`
 * and `/websites/nextjs` differing as two libraries is a trap, not a feature.
 */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * How deep a nested id may go, in slug segments after the namespace.
 * `/websites/a/b/c/d` is the deepest allowed. Grouping wants two or three
 * levels; anything deeper is a path, not a name.
 */
export const MAX_NESTED_SLUGS = 4;

/**
 * The slug a title suggests, so the wizard can fill the id in as the title is
 * typed instead of asking for it twice. Runs of anything outside the slug
 * alphabet fold to one dash, accents drop their marks first (`Café` gives
 * `cafe`), and the result is clipped to a segment's length. A title with no
 * usable characters -- one written in Chinese, say -- gives '' and the id has
 * to be typed; `normalizePublicId` is still the check on what was typed.
 */
export function slugFromTitle(title: string): string {
  const folded = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '');
  const clipped = folded.slice(0, 64).replace(/-+$/, '');
  return SLUG.test(clipped) && !isVersionLabelShaped(clipped) ? clipped : '';
}

/**
 * The shape `versionLabel` in lib/domain/ingestion.ts produces: a UTC date, a
 * digest prefix, an optional build number. A nested slug may not look like
 * one, because `/websites/ethereum/<label>` must keep meaning "that version of
 * `/websites/ethereum`" (requirement.md 6.1), and a library created at that id
 * would shadow it.
 */
const VERSION_LABEL_SHAPE = /^\d{8}-[0-9a-f]{8}(\.\d+)?$/;

export function isVersionLabelShaped(segment: string): boolean {
  return VERSION_LABEL_SHAPE.test(segment);
}

/** A GitHub owner or repository name, as GitHub itself allows them. */
const REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Owner names a repository library may not take, because they are already
 * namespaces.
 *
 * requirement.md 6.1 gives each source type its own prefix, which only works if
 * the prefixes are disjoint. `/owner/repository` has no prefix of its own, so
 * without this a repository owned by an org called `websites` would publish at
 * `/websites/thing` -- the same id a crawled site gets, and the first of the
 * two to be created would silently own it.
 */
const RESERVED_OWNERS = new Set(['websites', 'docs', 'notion']);

/**
 * Normalizes a typed Library ID, or returns null if it does not belong to this
 * source type's namespace.
 *
 * Normalizing rather than merely checking: an operator who types
 * `websites/nextjs` or `/websites/NextJS/` means the same library both times,
 * and the `library_public_id_uq` index only stops the duplicate if both spell
 * it the same way.
 */
export function normalizePublicId(type: ConnectedSourceType, input: string): string | null {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  if (trimmed.includes('//') || trimmed.includes('..')) return null;

  const segments = (trimmed.startsWith('/') ? trimmed.slice(1) : trimmed).split('/');
  const namespace = ID_NAMESPACE[type];

  if (namespace === 'repository') {
    if (segments.length !== 2) return null;
    const [owner, repository] = segments;
    if (!owner || !repository) return null;
    if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repository)) return null;
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;
    return `/${owner}/${repository}`;
  }

  if (segments.length < 2 || segments.length > 1 + MAX_NESTED_SLUGS) return null;
  const [prefix, ...slugs] = segments;
  if (prefix !== namespace) return null;
  const folded = slugs.map((slug) => slug.toLowerCase());
  if (!folded.every((slug) => SLUG.test(slug))) return null;
  /* Only the last segment can be mistaken for a version; the ones before it
     are always a library's, and are refused too so the rule reads simply. */
  if (folded.some(isVersionLabelShaped)) return null;
  return `/${namespace}/${folded.join('/')}`;
}

/* ------------------------------------------------------------- nesting */

/**
 * The id a nested library is grouped under, or null at the top of its
 * namespace. `/websites/ethereum/whitepaper` is under `/websites/ethereum`;
 * `/websites/ethereum` and `/vercel/next.js` are under nothing.
 */
export function parentPublicId(publicId: string): string | null {
  const segments = publicId.split('/').filter(Boolean);
  if (segments.length <= 2) return null;
  return `/${segments.slice(0, -1).join('/')}`;
}

export interface LibraryIdCandidate {
  publicId: string;
  /** The segments left over if `publicId` is the library, as a version label. */
  versionLabel: string | null;
}

/**
 * The ways a typed id can be read, longest library first.
 *
 * `/websites/ethereum/whitepaper` is either the library of that name, or the
 * `whitepaper` version of `/websites/ethereum`. A nested id and a pinned
 * version share one grammar, so the reading is decided by what exists: the
 * caller looks the candidates up and takes the first that is a library. Two
 * segments is the floor -- every library has at least a namespace and a slug,
 * or an owner and a repository.
 */
export function libraryIdCandidates(input: string): LibraryIdCandidate[] {
  const segments = input.split('/').filter(Boolean);
  const candidates: LibraryIdCandidate[] = [];
  for (let length = segments.length; length >= 2; length -= 1) {
    candidates.push({
      publicId: `/${segments.slice(0, length).join('/')}`,
      versionLabel: length === segments.length ? null : segments.slice(length).join('/'),
    });
  }
  return candidates;
}

/**
 * Orders a list so each library is followed by the libraries nested under it,
 * keeping the list's own order among siblings and among top-level entries.
 * A nested library whose parent is not in the list stays where it was: the
 * catalogue only groups what it is showing.
 */
export function groupNestedIds<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  const present = new Set(items.map(idOf));
  const children = new Map<string, T[]>();
  const roots: T[] = [];

  for (const item of items) {
    const parent = nearestPresentAncestor(idOf(item), present);
    if (parent === null) {
      roots.push(item);
    } else {
      children.set(parent, [...(children.get(parent) ?? []), item]);
    }
  }

  const ordered: T[] = [];
  const emit = (item: T) => {
    ordered.push(item);
    for (const child of children.get(idOf(item)) ?? []) emit(child);
  };
  for (const root of roots) emit(root);
  return ordered;
}

/** The closest ancestor id that is in `present`, walking up one segment at a time. */
function nearestPresentAncestor(publicId: string, present: ReadonlySet<string>): string | null {
  for (let parent = parentPublicId(publicId); parent !== null; parent = parentPublicId(parent)) {
    if (present.has(parent)) return parent;
  }
  return null;
}

/* ---------------------------------------------------------------- locations */

/**
 * Normalizes the place a source is fetched from.
 *
 * A GitHub source is a repository, so `owner/repo` and the browser URL a person
 * would paste both reduce to `owner/repo`. Everything else is fetched over the
 * network, and only over `https` -- an ingestion worker that follows `http` for
 * a library the platform publishes under its own name is a content-integrity
 * problem, not a convenience.
 */
export function normalizeLocation(type: ConnectedSourceType, input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return null;

  /* An upload's location is the key prefix its files sit under; the create
     use case builds it from ids, so this only confirms the shape. */
  if (isUploadSourceType(type)) {
    return /^uploads\/(platform|[0-9a-f-]{36})\/[0-9a-f-]{36}$/.test(trimmed) ? trimmed : null;
  }

  if (type === 'github') {
    const withoutHost = trimmed
      .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    const segments = withoutHost.split('/');
    if (segments.length !== 2) return null;
    const [owner, repository] = segments;
    if (!owner || !repository) return null;
    return REPO_SEGMENT.test(owner) && REPO_SEGMENT.test(repository)
      ? `${owner}/${repository}`
      : null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes('.')) return null;
  return url.toString();
}

/* ---------------------------------------------------------------- lifecycle */

/**
 * The lifecycle states a platform library can be in.
 *
 * A subset of `lifecycle_status`: the review states are unreachable for a
 * library that is not reviewed, and this is what the console filters on.
 */
export const PLATFORM_LIFECYCLE_STATES = ['draft', 'published', 'suspended', 'archived'] as const;

export type PlatformLifecycleState = (typeof PLATFORM_LIFECYCLE_STATES)[number];

export function isPlatformLifecycleState(value: unknown): value is PlatformLifecycleState {
  return (
    typeof value === 'string' && (PLATFORM_LIFECYCLE_STATES as readonly string[]).includes(value)
  );
}

/** What an operator may set from the console. Archiving is not one of them. */
export const PLATFORM_LIFECYCLE_ACTIONS = ['publish', 'suspend'] as const;

export type PlatformLifecycleAction = (typeof PLATFORM_LIFECYCLE_ACTIONS)[number];

export function isPlatformLifecycleAction(value: unknown): value is PlatformLifecycleAction {
  return (
    typeof value === 'string' && (PLATFORM_LIFECYCLE_ACTIONS as readonly string[]).includes(value)
  );
}

export function lifecycleTarget(action: PlatformLifecycleAction): PlatformLifecycleState {
  return action === 'publish' ? 'published' : 'suspended';
}

/**
 * Whether an action is available from a given state, ignoring index readiness.
 *
 * Publishing is reachable from `draft` and from `suspended` -- restoring a
 * paused library is the same decision as publishing it the first time, and
 * giving it a separate verb would mean a separate audit action for what the
 * operator experiences as one thing.
 */
export function lifecycleActionAvailable(
  state: PlatformLifecycleState,
  action: PlatformLifecycleAction,
): boolean {
  return action === 'publish'
    ? state === 'draft' || state === 'suspended'
    : state === 'published';
}

/* ----------------------------------------------------------- user review */

/**
 * What a build does to a user library's lifecycle once its version is
 * published. requirement.md 6.2 and architecture.md 8.1:
 *
 * - a private library is never reviewed by a person: it goes live as soon as
 *   the security scan and the index have passed, so `published`;
 * - a public library waits for a reviewer: `submitted`. A rebuild after
 *   `changes_requested` is the owner's resubmission, so it queues again;
 * - a platform library is published by an operator, never by a build;
 * - a suspended or archived library stays where it was put. A rebuild is not
 *   a way around a reviewer's decision.
 *
 * Null means the build leaves the status alone.
 */
export function lifecycleAfterBuild(input: {
  lifecycleStatus: LifecycleStatus;
  visibility: Visibility;
  isPlatformLibrary: boolean;
}): LifecycleStatus | null {
  if (input.isPlatformLibrary) return null;
  const from = input.lifecycleStatus;
  if (from === 'suspended' || from === 'archived') return null;
  if (input.visibility === 'private') return from === 'published' ? null : 'published';
  /*
   * A public build never queues itself (review-visibility-proposal.md 5):
   * the library stays indexed in `draft`, or in `changes_requested`, until
   * its owner brings the materials and confirms -- `submit` or `resubmit`
   * (`ownerActionAvailable`). The submission is the owner's act, whoever
   * reviews it afterwards.
   */
  return null;
}

/* ------------------------------------------------------ submission materials */

/**
 * What a public submission has to bring (review-visibility-proposal.md 5):
 * a rights declaration that permits a public library (lib/domain/rights.ts).
 *
 * The self-check question set is no longer part of it (2026-10-23). A
 * public library may bring one -- the rules layer publishes a verified
 * source on its hit rate, and the model layer reads it -- but a library
 * without one is not kept out of the queue. The set is required only of
 * an expert-library application, whose own gate counts it
 * (lib/domain/expert-library.ts `expertEvalReady`).
 */
export const SUBMISSION_BLOCKERS = ['rights', 'rights_generated'] as const;

export type SubmissionBlocker = (typeof SUBMISSION_BLOCKERS)[number];

export interface SubmissionMaterials {
  rightsDeclared: boolean;
  /** `rightsAllowPublic` of the declaration; irrelevant when none. */
  rightsAllowPublic: boolean;
}

/** What still stands between this library and the review queue, in the order the owner fixes them. */
export function submissionBlockers(materials: SubmissionMaterials): SubmissionBlocker[] {
  const blockers: SubmissionBlocker[] = [];
  if (!materials.rightsDeclared) blockers.push('rights');
  else if (!materials.rightsAllowPublic) blockers.push('rights_generated');
  return blockers;
}

export function submissionReady(materials: SubmissionMaterials): boolean {
  return submissionBlockers(materials).length === 0;
}

/**
 * The reviewer's three verbs over a user library (requirement.md 7.4), plus
 * the same verbs read as a safety pause and its lifting on a library that
 * needs no review.
 */
export const USER_REVIEW_ACTIONS = ['approve', 'request_changes', 'reject'] as const;

export type UserReviewAction = (typeof USER_REVIEW_ACTIONS)[number];

export function isUserReviewAction(value: unknown): value is UserReviewAction {
  return typeof value === 'string' && (USER_REVIEW_ACTIONS as readonly string[]).includes(value);
}

/**
 * Where each verb lands. There is no `rejected` state in the enum: a
 * rejected library is `suspended` -- out of retrieval, its content kept, and
 * reversible by a later approval -- which is also what a safety pause is.
 */
export function reviewTarget(action: UserReviewAction): LifecycleStatus {
  switch (action) {
    case 'approve':
      return 'published';
    case 'request_changes':
      return 'changes_requested';
    case 'reject':
      return 'suspended';
  }
}

/**
 * Whether a verb applies to a user library in a given state.
 *
 * A private library is not reviewed, so only the pause and its lifting apply
 * to it. `draft` is a library that has not built a version yet, and nothing
 * can be decided about content that does not exist; `archived` is terminal.
 */
export function reviewActionAvailable(
  state: LifecycleStatus,
  visibility: Visibility,
  action: UserReviewAction,
): boolean {
  if (state === 'draft' || state === 'archived') return false;
  if (visibility === 'private') {
    return action === 'approve' ? state === 'suspended' : action === 'reject' && state === 'published';
  }
  switch (action) {
    case 'approve':
      return state !== 'published';
    case 'request_changes':
      return state !== 'changes_requested';
    case 'reject':
      return state !== 'suspended';
  }
}

/* ------------------------------------------------------------------ errors */

/**
 * Why a change to a platform library was refused.
 *
 * Specific rather than coarse: unlike a sign-in, the caller is an entitled
 * operator looking at the record, and a generic failure would send them to the
 * logs to find out which field was wrong.
 */
export const PLATFORM_LIBRARY_ERRORS = [
  'not_found',
  'not_platform_library',
  'not_user_library',
  'invalid_title',
  'invalid_public_id',
  'public_id_taken',
  'unsupported_source',
  'invalid_location',
  'invalid_refresh_policy',
  'invalid_uploads',
  'nothing_to_change',
  'pdf_source_exists',
  'invalid_metadata',
  'invalid_transition',
  'no_ready_version',
  'no_version',
  'source_not_found',
  'last_source',
  'archived',
  'reason_required',
  /** A public library needs the owner's rights declaration (lib/domain/rights.ts) and none is on the row. */
  'rights_required',
  /** The declaration posted is incomplete or not among the options. */
  'rights_invalid',
  /** The declaration says the body was model-generated without review: not accepted as public (7.4). */
  'rights_generated',
  /** A public library's review decision came without the 7.4 checklist (lib/domain/review.ts). */
  'checklist_required',
  /** The checklist's verdicts contradict the verb: an approval with a failed check, or a send-back with none. */
  'checklist_mismatch',
  'eval_question_invalid',
  'eval_question_limit',
  'eval_unavailable',
  'unavailable',
] as const;

export type PlatformLibraryError = (typeof PLATFORM_LIBRARY_ERRORS)[number];

export function isPlatformLibraryError(value: unknown): value is PlatformLibraryError {
  return (
    typeof value === 'string' && (PLATFORM_LIBRARY_ERRORS as readonly string[]).includes(value)
  );
}

export class PlatformLibraryRefused extends Error {
  constructor(
    readonly code: PlatformLibraryError,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformLibraryRefused';
  }
}

/* ------------------------------------------------------------------ drafts */

export const TITLE_MAX_LENGTH = 120;
export const DESCRIPTION_MAX_LENGTH = 400;
export const TAG_MAX_LENGTH = 40;
export const LANGUAGE_MAX_LENGTH = 40;

/** A validated create, ready to insert. */
export interface PlatformLibraryDraft {
  publicId: string;
  title: string;
  description: string | null;
  domainTag: string | null;
  language: string | null;
  sourceType: PlatformLibraryType;
  location: string;
  refreshPolicy: RefreshPolicy;
  /** Website/llms.txt only: child pages or nested indexes to follow. */
  indexDepth: IndexDepth;
  /** `pdf` only: the uploads the manifest listed, keyed under the platform prefix. */
  files: UploadedFile[];
}

export interface PlatformLibraryInput {
  title: string;
  publicId: string;
  sourceType: string;
  /** Ignored for `pdf`, whose location is the prefix its uploads sit under. */
  location: string;
  /** Ignored for `pdf`: there is nothing to re-fetch, so it is always manual. */
  refreshPolicy: string;
  /** Website/llms.txt only: child pages or nested indexes to follow. */
  indexDepth?: unknown;
  /**
   * `pdf` only: the manifest the console posted after uploading, as parsed
   * JSON; absent or null creates the library empty, to be filled in from
   * its files panel.
   */
  uploads?: unknown;
  description?: string;
  domainTag?: string;
  language?: string;
}

/**
 * Validates one create, field by field, and throws the first refusal.
 *
 * Ordered so the operator is told about the field they are most likely to have
 * got wrong first: the source type decides which Library IDs and locations are
 * even legal, so a wrong type would otherwise be reported as a wrong id.
 */
export function draftPlatformLibrary(input: PlatformLibraryInput): PlatformLibraryDraft {
  if (!isPlatformLibraryType(input.sourceType)) {
    throw new PlatformLibraryRefused('unsupported_source', 'unsupported source type');
  }
  const sourceType = input.sourceType;

  const title = input.title.trim();
  if (title.length === 0 || title.length > TITLE_MAX_LENGTH) {
    throw new PlatformLibraryRefused('invalid_title', 'a title is required');
  }

  const publicId = normalizePublicId(sourceType, input.publicId);
  if (!publicId) {
    throw new PlatformLibraryRefused(
      'invalid_public_id',
      `a ${sourceType} library is published under ${namespaceFor(sourceType)}`,
    );
  }

  /*
   * A pdf library's location and cadence are not the operator's to type: the
   * location is the prefix its uploads were keyed under, and there is nothing
   * to re-fetch on a schedule -- a changed file list queues its own rebuild
   * (`updatePlatformLibraryFiles`). An empty manifest is a library created
   * before its files, filled in from the files panel.
   */
  let location: string | null;
  let refreshPolicy: RefreshPolicy;
  let files: UploadedFile[] = [];
  if (sourceType === 'pdf') {
    const manifest =
      input.uploads === undefined || input.uploads === null
        ? { batchId: uuidv7(), files: [] }
        : parseUploadManifest(input.uploads, PLATFORM_UPLOAD_OWNER);
    if (!manifest) {
      throw new PlatformLibraryRefused('invalid_uploads', 'the upload manifest is not valid');
    }
    files = manifest.files;
    location = uploadPrefix(PLATFORM_UPLOAD_OWNER, manifest.batchId);
    refreshPolicy = 'manual';
  } else {
    location = normalizeLocation(sourceType, input.location);
    if (!isRefreshPolicy(input.refreshPolicy)) {
      throw new PlatformLibraryRefused('invalid_refresh_policy', 'unknown refresh policy');
    }
    refreshPolicy = input.refreshPolicy;
  }
  if (!location) {
    throw new PlatformLibraryRefused('invalid_location', 'the source location is not usable');
  }

  const description = optional(input.description, DESCRIPTION_MAX_LENGTH);
  const domainTag = optional(input.domainTag, TAG_MAX_LENGTH);
  const language = optional(input.language, LANGUAGE_MAX_LENGTH);

  return {
    publicId,
    title,
    description,
    domainTag,
    language,
    sourceType,
    location,
    refreshPolicy,
    indexDepth:
      sourceType === 'website' || sourceType === 'llms_txt'
        ? parseIndexDepth(input.indexDepth)
        : DEFAULT_INDEX_DEPTH,
    files,
  };
}

/**
 * An optional free-text field: empty becomes null, over-long is refused.
 *
 * Refused rather than truncated. These are descriptions and tags shown in the
 * public catalogue, and silently cutting one in half produces a record that
 * looks like the operator wrote it that way.
 */
function optional(value: string | undefined, max: number): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new PlatformLibraryRefused('invalid_metadata', 'a field is longer than allowed');
  }
  return trimmed;
}

/**
 * The description and language of a workspace's own library, under the same
 * rule the edit form has always applied (`editWorkspaceLibrary`).
 *
 * Exported because creation needs it too. The columns are unbounded `text`,
 * so a create that skipped the check stored whatever was posted -- a value the
 * public page then rendered and the metadata form could never save again,
 * because the edit path would refuse the length it was handed.
 */
export function libraryDescription(value: string | null | undefined): string | null {
  return optional(value ?? undefined, DESCRIPTION_MAX_LENGTH);
}

export function libraryLanguage(value: string | null | undefined): string | null {
  return optional(value ?? undefined, LANGUAGE_MAX_LENGTH);
}

/* ------------------------------------------------------------------- edits */

/** A validated metadata edit, ready to update. */
export interface PlatformLibraryEdit {
  publicId: string;
  title: string;
  description: string | null;
  domainTag: string | null;
  language: string | null;
}

export interface PlatformLibraryEditInput {
  /** The type the library was created under. Its namespace is immutable. */
  sourceType: PlatformLibraryType;
  title: string;
  publicId: string;
  description?: string;
  domainTag?: string;
  language?: string;
}

/**
 * Validates an edit of the fields the catalogue shows.
 *
 * The Library ID is editable, and deliberately so: requirement.md 6.1 says a
 * slug change keeps a redirect, which is only meaningful if a slug can change
 * at all. What it may not do is leave its namespace -- the namespace is decided
 * by the source type (requirement.md 6.1), and moving `/websites/x` to
 * `/docs/x` would be a different kind of library wearing the same row.
 *
 * The source type itself is not editable here. Changing it would invalidate
 * every version already built from the old one, and the honest way to do that
 * is a new library.
 */
export function editPlatformLibrary(input: PlatformLibraryEditInput): PlatformLibraryEdit {
  const title = input.title.trim();
  if (title.length === 0 || title.length > TITLE_MAX_LENGTH) {
    throw new PlatformLibraryRefused('invalid_title', 'a title is required');
  }

  const publicId = normalizePublicId(input.sourceType, input.publicId);
  if (!publicId) {
    throw new PlatformLibraryRefused(
      'invalid_public_id',
      `a ${input.sourceType} library is published under ${namespaceFor(input.sourceType)}`,
    );
  }

  return {
    publicId,
    title,
    description: optional(input.description, DESCRIPTION_MAX_LENGTH),
    domainTag: optional(input.domainTag, TAG_MAX_LENGTH),
    language: optional(input.language, LANGUAGE_MAX_LENGTH),
  };
}

/* ----------------------------------------------------------------- sources */

/**
 * How many nested levels a web source follows. For `llms.txt`, each level
 * follows same-host indexes named by the previous one. For a website, each
 * level follows child-page links (and sitemap pages count as level one).
 * Zero is the default. Stored on `source.config.indexDepth`; meaningless for
 * other source types.
 */
export const INDEX_DEPTHS = [0, 1, 2, 3] as const;

export type IndexDepth = (typeof INDEX_DEPTHS)[number];

export const DEFAULT_INDEX_DEPTH: IndexDepth = 0;

/** A form value or a stored config value as a depth; anything else is the default. */
export function parseIndexDepth(value: unknown): IndexDepth {
  const n = typeof value === 'string' ? Number(value) : value;
  return (INDEX_DEPTHS as readonly number[]).includes(n as number)
    ? (n as IndexDepth)
    : DEFAULT_INDEX_DEPTH;
}

export function indexDepthOf(config: Record<string, unknown>): IndexDepth {
  return parseIndexDepth(config.indexDepth);
}

/** A validated source, ready to insert or update. */
export interface PlatformSourceDraft {
  type: PlatformLibraryType;
  location: string;
  refreshPolicy: RefreshPolicy;
  indexDepth: IndexDepth;
  /** `pdf` only: the uploads the manifest listed, keyed under the platform prefix. */
  files: UploadedFile[];
}

/**
 * Validates one source of a platform library.
 *
 * Shares `normalizeLocation` with the create form rather than re-deriving the
 * rules, so a location the create form refuses cannot arrive through the edit
 * one. requirement.md 6.1 allows a library more than one source, which is why
 * this exists apart from `draftPlatformLibrary`.
 */
export function draftPlatformSource(input: {
  type: string;
  location: string;
  refreshPolicy: string;
  /** Only read for website and `llms_txt`; every other type stores the default. */
  indexDepth?: unknown;
  /** `pdf` only: the manifest the console posted after uploading; absent adds an empty source. */
  uploads?: unknown;
}): PlatformSourceDraft {
  if (!isPlatformLibraryType(input.type)) {
    throw new PlatformLibraryRefused('unsupported_source', 'unsupported source type');
  }
  /* A pdf source is its uploads: location and cadence are derived, as on a
     create (`draftPlatformLibrary`), and the type is what the files panel
     manages afterwards. */
  if (input.type === 'pdf') {
    const manifest =
      input.uploads === undefined || input.uploads === null
        ? { batchId: uuidv7(), files: [] }
        : parseUploadManifest(input.uploads, PLATFORM_UPLOAD_OWNER);
    if (!manifest) {
      throw new PlatformLibraryRefused('invalid_uploads', 'the upload manifest is not valid');
    }
    return {
      type: 'pdf',
      location: uploadPrefix(PLATFORM_UPLOAD_OWNER, manifest.batchId),
      refreshPolicy: 'manual',
      indexDepth: DEFAULT_INDEX_DEPTH,
      files: manifest.files,
    };
  }
  const location = normalizeLocation(input.type, input.location);
  if (!location) {
    throw new PlatformLibraryRefused('invalid_location', 'the source location is not usable');
  }
  if (!isRefreshPolicy(input.refreshPolicy)) {
    throw new PlatformLibraryRefused('invalid_refresh_policy', 'unknown refresh policy');
  }
  return {
    type: input.type,
    location,
    refreshPolicy: input.refreshPolicy,
    indexDepth:
      input.type === 'website' || input.type === 'llms_txt'
        ? parseIndexDepth(input.indexDepth)
        : DEFAULT_INDEX_DEPTH,
    files: [],
  };
}

/**
 * Whatever was typed or pasted into an id field, as the part that follows
 * `prefix` (`/websites/`, or `/` for a repository).
 *
 * Only the namespace itself is stripped (`websites/` from a pasted
 * `/websites/ethereum/whitepaper`), never the segments after it: slugs nest
 * (requirement.md 6.1), so `ethereum/whitepaper` is a slug the operator meant
 * and the slash in it is theirs to type. A pasted id that repeats the prefix
 * is still folded back rather than doubled. The near miss the field exists to
 * absorb -- `website/` for `websites/` -- is refused by `normalizePublicId`
 * with the namespace sentence rather than silently corrected, because
 * correcting it would mean guessing which of the typed segments was the typo.
 */
export function slugWithoutPrefix(value: string, prefix: string): string {
  let rest = value.replace(/^\/+/, '');
  if (prefix !== '/') {
    const namespace = prefix.slice(1, -1).toLowerCase();
    if (rest.toLowerCase().startsWith(`${namespace}/`)) rest = rest.slice(namespace.length + 1);
    rest = rest.replace(/^\/+/, '');
  }
  return rest;
}

/* --------------------------------------------------------- owner management */

/**
 * The owner's verbs over their own library, beside rebuild and delete.
 * requirement.md 5.2: pause, resume and resubmit must each give a definite
 * result, and only the owner side may use them.
 *
 * The lifecycle enum has one stopped state, `suspended`, and it is shared
 * with the reviewer's rejection and a safety pause. What tells an owner's
 * pause apart is the `library_review` row it writes (stage `OWNER_REVIEW_STAGE`,
 * outcome `pause`): a library whose newest review row is an owner pause was
 * stopped by its owner and may be resumed by them; one whose newest row is a
 * reviewer's decision was not, and the owner cannot lift it (the reviewer's
 * word is not undone from the dashboard, as `lifecycleAfterBuild` already
 * says of a rebuild).
 */
export const OWNER_LIFECYCLE_ACTIONS = ['pause', 'resume', 'submit', 'resubmit', 'appeal'] as const;

/** `library_review.stage` values a machine wrote (lib/application/review); an owner may appeal their send-back. */
export const MACHINE_REVIEW_STAGES = ['rules', 'model'] as const;

/**
 * The machine decision an owner may appeal (review-visibility-proposal.md
 * 6.3): the newest review row is a rules-layer or model-layer send-back,
 * and no appeal names it yet. Null otherwise. One appeal per decision: a
 * person then decides, and a person's decision is not appealed here.
 */
export function appealableDecision(
  reviews: readonly { id: string; stage: string; outcome: string | null; appealOf: string | null }[],
): string | null {
  const newest = reviews[0];
  if (!newest) return null;
  if (!(MACHINE_REVIEW_STAGES as readonly string[]).includes(newest.stage)) return null;
  if (newest.outcome !== 'request_changes') return null;
  if (reviews.some((review) => review.appealOf === newest.id)) return null;
  return newest.id;
}

export type OwnerLifecycleAction = (typeof OWNER_LIFECYCLE_ACTIONS)[number];

export function isOwnerLifecycleAction(value: unknown): value is OwnerLifecycleAction {
  return (
    typeof value === 'string' && (OWNER_LIFECYCLE_ACTIONS as readonly string[]).includes(value)
  );
}

/** `library_review.stage` of a row the owner wrote from the dashboard. */
export const OWNER_REVIEW_STAGE = 'owner';

/** Whether a review row records the owner pausing the library. */
export function isOwnerPause(
  review: { stage: string; outcome: string | null } | null | undefined,
): boolean {
  return review?.stage === OWNER_REVIEW_STAGE && review.outcome === 'pause';
}

export interface OwnerActionContext {
  lifecycleStatus: LifecycleStatus;
  visibility: Visibility;
  /** True when the newest review row is an owner pause (`isOwnerPause`). */
  pausedByOwner: boolean;
  /** True when the current version is indexed; a submission needs one. */
  hasReadyVersion: boolean;
  /** `submissionReady`: the rights declaration and the questions are in. Absent means in. */
  materialsReady?: boolean;
  /** `appealableDecision` found one. Absent means none. */
  appealable?: boolean;
}

/**
 * Whether an owner's verb applies right now.
 *
 * - `pause` stops a live library: only `published` has anything to stop. A
 *   library in review is the reviewer's to decide and is not paused around
 *   them; a draft has nothing running.
 * - `resume` lifts the owner's own pause and nothing else.
 * - `submit` queues a public library whose build finished before its
 *   materials were in (`lifecycleAfterBuild` left it in `draft`), once they
 *   are.
 * - `resubmit` sends a public library the reviewer returned back to the
 *   queue without a rebuild -- for the owner who fixed what was asked by
 *   editing metadata or scope rather than content.
 * - `appeal` sends a public library a machine sent back straight to a
 *   person, once per decision (`appealableDecision`), without changing
 *   anything -- the owner disputes the decision, not the content.
 *
 * All three submissions need an indexed version, as approval does, so the
 * reviewer is not handed an empty index, and the materials, so they are
 * not handed a library with nothing to check it by.
 */
export function ownerActionAvailable(
  context: OwnerActionContext,
  action: OwnerLifecycleAction,
): boolean {
  const { lifecycleStatus: state, visibility } = context;
  if (state === 'archived') return false;
  const submittable = visibility === 'public' && context.hasReadyVersion && context.materialsReady !== false;
  switch (action) {
    case 'pause':
      return state === 'published';
    case 'resume':
      return state === 'suspended' && context.pausedByOwner;
    case 'submit':
      return state === 'draft' && submittable;
    case 'resubmit':
      return state === 'changes_requested' && submittable;
    case 'appeal':
      return state === 'changes_requested' && submittable && context.appealable === true;
  }
}

/** Where each owner verb lands. */
export function ownerActionTarget(action: OwnerLifecycleAction): LifecycleStatus {
  switch (action) {
    case 'pause':
      return 'suspended';
    case 'resume':
      return 'published';
    case 'submit':
    case 'resubmit':
    case 'appeal':
      return 'submitted';
  }
}

/* --------------------------------------------------------- metadata edits */

/**
 * What a visibility change does to the lifecycle. requirement.md 5.2 and
 * 6.2: a private library is never reviewed by a person, a public one always
 * is, and the two are kept apart from the index.
 *
 * - public -> private: whatever review the library was waiting on no longer
 *   applies, so a library with an indexed version goes live and one without
 *   goes back to `draft` for its first build to publish. A suspension stays:
 *   a safety pause applies to private libraries too, and going private is
 *   not a way around a reviewer.
 * - private -> public: a live library is now a stranger's public library
 *   and is never live unreviewed, so it goes back to `draft` and waits
 *   for its owner to bring the materials and submit it (review-visibility-
 *   proposal.md 5); a draft stays a draft; a suspension stays.
 *
 * Null means the status is left alone. Archived is refused, not moved.
 */
export function visibilityTransition(input: {
  from: Visibility;
  to: Visibility;
  lifecycleStatus: LifecycleStatus;
  hasReadyVersion: boolean;
}): LifecycleStatus | null {
  if (input.lifecycleStatus === 'archived') {
    throw new PlatformLibraryRefused('archived', 'an archived library is not edited');
  }
  if (input.from === input.to) return null;
  const state = input.lifecycleStatus;
  if (state === 'suspended' || state === 'draft') return null;
  if (input.to === 'private') {
    if (state === 'published') return null;
    return input.hasReadyVersion ? 'published' : 'draft';
  }
  return state === 'published' ? 'draft' : null;
}

/** A validated metadata edit of a workspace's own library. */
export interface WorkspaceLibraryEdit {
  title: string;
  description: string | null;
  language: string | null;
  visibility: Visibility;
  /** The lifecycle the visibility change implies; null keeps the current one. */
  lifecycleStatus: LifecycleStatus | null;
}

/**
 * Validates the fields an owner may change from the dashboard: title,
 * description, language and visibility. The Library ID is not among them --
 * for a repository it is the repository, and for the rest a rename is a
 * redirect the catalogue has to keep (requirement.md 6.1), which is more
 * than "edit metadata" should do quietly.
 */
export function editWorkspaceLibrary(input: {
  title: string;
  description?: string;
  language?: string;
  visibility: string;
  current: {
    visibility: Visibility;
    lifecycleStatus: LifecycleStatus;
    hasReadyVersion: boolean;
  };
}): WorkspaceLibraryEdit {
  const title = input.title.trim();
  if (title.length === 0 || title.length > TITLE_MAX_LENGTH) {
    throw new PlatformLibraryRefused('invalid_title', 'a title is required');
  }
  if (input.visibility !== 'public' && input.visibility !== 'private') {
    throw new PlatformLibraryRefused('invalid_metadata', 'unknown visibility');
  }
  const visibility: Visibility = input.visibility;
  return {
    title,
    description: optional(input.description, DESCRIPTION_MAX_LENGTH),
    language: optional(input.language, LANGUAGE_MAX_LENGTH),
    visibility,
    lifecycleStatus: visibilityTransition({
      from: input.current.visibility,
      to: visibility,
      lifecycleStatus: input.current.lifecycleStatus,
      hasReadyVersion: input.current.hasReadyVersion,
    }),
  };
}

/* ------------------------------------------------------------ parse scope */

/**
 * The owner's parse scope: which paths of the source a build indexes.
 * Stored on `source.config` under the same names `re0.json` uses
 * (requirement.md 7.2 -- `folders`, `excludeFolders`, `excludeFiles`), so a
 * reader of either sees one vocabulary, plus `indexDepth` for a website or
 * `llms.txt` source. Applied by the connector registry after the fetch, with
 * the same rule as the repository's own file (`pathIncluded`): exclusions win.
 */
export interface ParseScope {
  folders: string[];
  excludeFolders: string[];
  excludeFiles: string[];
  indexDepth: IndexDepth;
}

export const EMPTY_PARSE_SCOPE: ParseScope = {
  folders: [],
  excludeFolders: [],
  excludeFiles: [],
  indexDepth: DEFAULT_INDEX_DEPTH,
};

/** The same caps `parseSourceConfig` applies to `re0.json`. */
export const PARSE_SCOPE_LIMITS = { maxEntries: 64, maxPathLength: 200 } as const;

/** Source types whose files have paths a scope can select. */
export function parseScopeApplies(type: string): boolean {
  return type === 'github' || type === 'website' || type === 'llms_txt';
}

/** The scope a source's stored config carries; malformed entries are dropped. */
export function parseScopeOf(config: Record<string, unknown>): ParseScope {
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string' && isScopePath(entry))
      : [];
  return {
    folders: list(config.folders),
    excludeFolders: list(config.excludeFolders),
    excludeFiles: list(config.excludeFiles),
    indexDepth: indexDepthOf(config),
  };
}

/** True when a scope narrows nothing. */
export function parseScopeIsEmpty(scope: ParseScope): boolean {
  return (
    scope.folders.length === 0 &&
    scope.excludeFolders.length === 0 &&
    scope.excludeFiles.length === 0
  );
}

/**
 * Validates a scope an owner typed, refusing rather than dropping: a person
 * filling in a form should be told which line is wrong, not have it vanish.
 * Each field is one path or glob per line (commas accepted); the rules are
 * those of `re0.json` -- relative, no `..`, no backslashes, bounded.
 */
export function draftParseScope(input: {
  sourceType: string;
  folders?: string;
  excludeFolders?: string;
  excludeFiles?: string;
  indexDepth?: unknown;
}): ParseScope {
  if (!parseScopeApplies(input.sourceType)) {
    throw new PlatformLibraryRefused('unsupported_source', 'this source has no parse scope');
  }
  return {
    folders: scopeLines(input.folders),
    excludeFolders: scopeLines(input.excludeFolders),
    excludeFiles: scopeLines(input.excludeFiles),
    indexDepth:
      input.sourceType === 'website' || input.sourceType === 'llms_txt'
        ? parseIndexDepth(input.indexDepth)
        : DEFAULT_INDEX_DEPTH,
  };
}

function scopeLines(value: string | undefined): string[] {
  const entries = (value ?? '')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length > PARSE_SCOPE_LIMITS.maxEntries) {
    throw new PlatformLibraryRefused('invalid_metadata', 'too many scope entries');
  }
  const kept: string[] = [];
  for (const entry of entries) {
    const normalized = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!isScopePath(normalized)) {
      throw new PlatformLibraryRefused('invalid_metadata', `${entry} is not a usable path`);
    }
    if (!kept.includes(normalized)) kept.push(normalized);
  }
  return kept;
}

function isScopePath(entry: string): boolean {
  return (
    entry.length > 0 &&
    entry.length <= PARSE_SCOPE_LIMITS.maxPathLength &&
    !entry.startsWith('/') &&
    !entry.includes('..') &&
    !entry.includes('\\') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(entry)
  );
}

/** A source's refresh cadence may be set when there is something to re-fetch. */
export function refreshPolicyEditable(type: string): boolean {
  return isConnectedSourceType(type) && !isUploadSourceType(type);
}

/**
 * What one save of the configure form may write.
 *
 * The form carries two settings behind one button and they do not belong to
 * the same set of sources: the parse scope needs paths to select
 * (`parseScopeApplies` -- github, website, llms_txt), while the refresh
 * cadence needs only something to re-fetch (`refreshPolicyEditable` -- every
 * connected source that is not an upload, so OpenAPI and Notion too). A save
 * is therefore refused only when the source offers neither half, never
 * because the scope half happens not to apply: an OpenAPI library setting its
 * cadence to daily is a legitimate save with no scope in it.
 */
export interface ScopeSavePlan {
  /** The scope fields are the owner's to set on this source. */
  scope: boolean;
  /** A cadence was posted and this source has one. */
  cadence: boolean;
}

export function planScopeSave(input: {
  sourceType: string;
  /** True when the form actually carried a cadence, not just an empty field. */
  cadencePosted: boolean;
}): ScopeSavePlan {
  if (input.cadencePosted && !refreshPolicyEditable(input.sourceType)) {
    throw new PlatformLibraryRefused('unsupported_source', 'this source has no refresh cadence');
  }
  const scope = parseScopeApplies(input.sourceType);
  if (!scope && !input.cadencePosted) {
    throw new PlatformLibraryRefused('unsupported_source', 'this source has no parse scope');
  }
  return { scope, cadence: input.cadencePosted };
}

/* ------------------------------------------------- parse scope precedence */

/**
 * Two writers reach `source.config.folders` and its neighbours, and they must
 * agree on who wins.
 *
 * requirement.md 7.2 makes `re0.json` the *source's own* declaration of its
 * scope, and every build stamps what the file declared back onto the row
 * (`buildVersion`) so the library page can show the scope the index obeyed.
 * The dashboard's parse scope (`updateParseScope`) is the *owner's override*
 * of that declaration, and the override wins: a scope the owner saved is
 * never replaced by a build.
 *
 * The stored keys alone cannot tell the two apart -- `folders: ['docs']` looks
 * the same whichever writer put it there -- so the owner's save records
 * `ownerScoped`. Without that marker a source with no `re0.json` (whose web
 * and markdown connectors declare an empty config) wrote `[]` over the saved
 * scope on the very next build, and the build after that indexed everything.
 *
 * `ownerScoped` is written only here. `parseSourceConfig` keeps only the keys
 * it knows, so no repository's own file can set it.
 */
export const OWNER_SCOPED_KEY = 'ownerScoped';

/** True when the stored scope is the owner's override rather than a stamp. */
export function ownerScoped(config: Record<string, unknown>): boolean {
  return config[OWNER_SCOPED_KEY] === true;
}

/** `source.config` after the owner saved a scope from the dashboard. */
export function withOwnerParseScope(
  config: Record<string, unknown>,
  scope: ParseScope,
  sourceType: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...config,
    folders: scope.folders,
    excludeFolders: scope.excludeFolders,
    excludeFiles: scope.excludeFiles,
    /* Clearing every field hands the source back to its own `re0.json`. */
    [OWNER_SCOPED_KEY]: !parseScopeIsEmpty(scope),
  };
  if (sourceType === 'website' || sourceType === 'llms_txt') {
    next.indexDepth = scope.indexDepth;
  }
  return next;
}

/**
 * `source.config` after a build read the source's `re0.json`, or null when
 * nothing should be written: the owner has overridden the scope, or the
 * declaration already matches what the row holds.
 */
export function withDeclaredParseScope(
  config: Record<string, unknown>,
  declared: { folders: string[]; excludeFolders: string[] },
): Record<string, unknown> | null {
  if (ownerScoped(config)) return null;
  const same = (declaredEntries: string[], stored: unknown) =>
    JSON.stringify(declaredEntries) === JSON.stringify(Array.isArray(stored) ? stored : []);
  if (
    same(declared.folders, config.folders) &&
    same(declared.excludeFolders, config.excludeFolders)
  ) {
    return null;
  }
  return { ...config, folders: declared.folders, excludeFolders: declared.excludeFolders };
}

/* ------------------------------------------------------- rebuild affordance */

/**
 * Whether a build of this source fetches pages from a host, and so is quoted
 * against the crawl limit (library-build-billing.md 4.1). A repository, a
 * Notion space and an upload pull no pages, so their build is quoted cheaper.
 *
 * Shared so the library list and the library page quote the same library the
 * same way; before it they disagreed, one quoting the worst case for every
 * row and the other looking at the source.
 */
export function buildFetchesPages(sourceType: string | null | undefined): boolean {
  return (
    typeof sourceType === 'string' &&
    isConnectedSourceType(sourceType) &&
    requiresDomainVerification(sourceType)
  );
}

/**
 * Whether the rebuild button is refused, from the two facts that decide it:
 * an archived library is not rebuilt, and neither is one the workspace cannot
 * pay for. `affordable` is `undefined` where no quote was taken.
 */
export function rebuildBlocked(input: {
  lifecycleStatus: LifecycleStatus;
  affordable: boolean | undefined;
}): boolean {
  return input.lifecycleStatus === 'archived' || input.affordable === false;
}

/* --------------------------------------------------------- review pipeline */

/**
 * The public publishing pipeline requirement.md 5.2 names: rights and source,
 * content parsing, quality and safety, then -- review-visibility-proposal.md
 * 5 -- the owner's materials and their confirmation, the platform's review
 * (the rules, a model, or a person), publication. A private library skips
 * the materials and review steps but not the safety one.
 */
export const REVIEW_PIPELINE_STEPS = ['rights', 'parse', 'safety', 'materials', 'review', 'publish'] as const;

/** The steps a private library does not take. */
const PUBLIC_ONLY_STEPS: readonly ReviewPipelineStep[] = ['materials', 'review'];

export type ReviewPipelineStep = (typeof REVIEW_PIPELINE_STEPS)[number];

export type ReviewPipelineState = 'done' | 'active' | 'pending' | 'blocked';

export interface ReviewPipelineEntry {
  step: ReviewPipelineStep;
  state: ReviewPipelineState;
}

/**
 * Where a library stands in that pipeline, from the facts the row carries.
 *
 * The rights step is the owner's declaration (lib/domain/rights.ts): done
 * once a declaration that permits a public library is on the row, blocked
 * until then. Parsing and the safety scan happen inside a build, so both
 * follow the index; the human step follows the lifecycle; publication is
 * the two agreeing (`isQueryable`).
 */
export function reviewPipeline(input: {
  visibility: Visibility;
  lifecycleStatus: LifecycleStatus;
  indexStatus: IndexStatus;
  /** A build is queued or running. */
  building: boolean;
  /** A declaration permitting a public library is on the row; absent means yes (private, or a caller that does not know). */
  rightsDeclared?: boolean;
}): ReviewPipelineEntry[] {
  const { lifecycleStatus: state, indexStatus } = input;
  const steps = REVIEW_PIPELINE_STEPS.filter(
    (step) => input.visibility === 'public' || !PUBLIC_ONLY_STEPS.includes(step),
  );
  const indexed = indexStatus === 'ready' || indexStatus === 'stale';
  const parse: ReviewPipelineState = indexed
    ? 'done'
    : input.building || indexStatus === 'processing'
      ? 'active'
      : indexStatus === 'failed'
        ? 'blocked'
        : 'pending';
  const review: ReviewPipelineState =
    state === 'published'
      ? 'done'
      : state === 'submitted' || state === 'reviewing'
        ? 'active'
        : state === 'changes_requested' || state === 'suspended'
          ? 'blocked'
          : 'pending';
  const published = state === 'published' && indexed;
  /*
   * The owner's step: once the build is done, the library waits here until
   * the materials are in and the owner confirms (`submit`). A library that
   * has been submitted, decided or sent back has been through it; a
   * send-back reopens it only as far as the resubmission, which is the
   * review step's business.
   */
  const materials: ReviewPipelineState = state === 'draft' ? (parse === 'done' ? 'active' : 'pending') : 'done';

  return steps.map((step): ReviewPipelineEntry => {
    switch (step) {
      case 'rights':
        return { step, state: input.rightsDeclared === false ? 'blocked' : 'done' };
      case 'parse':
        return { step, state: parse };
      case 'safety':
        return { step, state: parse };
      case 'materials':
        return { step, state: materials };
      case 'review':
        return { step, state: parse === 'done' || review === 'blocked' ? review : 'pending' };
      case 'publish':
        return {
          step,
          state: published
            ? 'done'
            : state === 'suspended' || state === 'archived'
              ? 'blocked'
              : 'pending',
        };
    }
  });
}
