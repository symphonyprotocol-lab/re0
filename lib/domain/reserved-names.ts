/**
 * Names nobody may take at the root of an id or a path.
 *
 * A GitHub asset's id is `/{owner}/{repo}` with no namespace of its own, so it
 * shares the root with every other namespace (`/websites/...`, `/docs/...`,
 * `/notion/...`, and the P3 ones) and with the site's own first path segments.
 * A repository owned by an org called `websites` would otherwise publish at
 * `/websites/thing` -- the id a crawled site gets -- and whichever was created
 * first would silently own it. agent-first-proposal.md 3.2 widens the three
 * names requirement.md 6.1 used to reserve into this explicit list.
 *
 * One list, read by three rules: the asset-id grammar refuses a repository id
 * under a reserved owner (`normalizePublicId`), creation refuses such a
 * repository with a message to contact support, and a workspace handle may
 * not be one (lib/domain/handle.ts) since `/u/{handle}` and the P3 asset ids
 * put handles in paths too. A contract test keeps the list in step with the
 * first segments of the app's routes.
 *
 * Pure TypeScript, no imports -- domain layer rules apply.
 */

/** The asset id namespaces (proposal 3.2). */
const NAMESPACES = ['websites', 'docs', 'notion', 'posts', 'audio', 'qa'] as const;

/**
 * The first path segments the site serves, and the ones proposal 3.2 names
 * outright. `libraries` and `publishers` are retired paths (P1, P0) kept here
 * so a handle or owner cannot step into them if they ever come back.
 */
const ROUTES = [
  'a2a',
  'about',
  'admin',
  'api',
  'assets',
  'channels',
  'checkout',
  'contact',
  'dashboard',
  'embed',
  'files',
  'legal',
  'libraries',
  'login',
  'mcp',
  /* Signed redirects to article images and episode files (proposal 6.5, 6.6). */
  'media',
  'playground',
  'pricing',
  'publishers',
  's',
  'status',
  'u',
  'v1',
  'well-known',
  '.well-known',
  'sitemap.xml',
  'robots.txt',
  'opengraph-image',
  'widget',
  'widget.js',
] as const;

/**
 * Names that read as the platform speaking. `re0` is also the slug of the
 * platform's own channel.
 */
const PLATFORM = ['re0', 'support', 'help', 'root', 'system', 'official'] as const;

export const RESERVED_NAMES: ReadonlySet<string> = new Set<string>([
  ...NAMESPACES,
  ...ROUTES,
  ...PLATFORM,
]);

/** Whether `name` is reserved, compared the way GitHub compares logins: without case. */
export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name.trim().toLowerCase());
}

/**
 * Whether a GitHub location or repository id names a reserved owner.
 * Accepts `owner/repo`, `/owner/repo` or the browser URL; anything without an
 * owner segment is not this rule's to refuse.
 */
export function hasReservedOwner(location: string): boolean {
  const owner = location
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^\/+/, '')
    .split('/')[0];
  return owner ? isReservedName(owner) : false;
}
