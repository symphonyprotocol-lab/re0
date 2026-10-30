/**
 * Site key rules, as pure functions. requirement.md 9.4 (网站插件).
 *
 * A site key is a *publishable* credential: it is pasted into a customer's
 * HTML, so every visitor of that site can read it. Secrecy is therefore not
 * what protects the owner's quota; two other things are, and both are the
 * key's own configuration:
 *
 * - the origin allowlist: the widget page is only served to a parent page
 *   whose origin the owner listed, and the browser enforces that through
 *   `Content-Security-Policy: frame-ancestors`;
 * - the daily limit: however many visitors a site has, one key spends at
 *   most this many Calls a day from the workspace's quota.
 *
 * Because the key is public, the row stores it in the clear (there is nothing
 * to protect by hashing a value that lives in a web page), and the dashboard
 * shows it again on every visit.
 */

export const SITE_KEY_PREFIX = 'mm_site_';

/** How many origins one key may list. A site with more is several sites. */
export const SITE_KEY_MAX_ORIGINS = 20;

export const SITE_KEY_DAILY_LIMIT_DEFAULT = 200;
export const SITE_KEY_DAILY_LIMIT_MIN = 1;
export const SITE_KEY_DAILY_LIMIT_MAX = 10_000;

/** The owner's greeting, shown before the first question. */
export const SITE_KEY_WELCOME_MAX = 200;

/** The default button colour: black, so an unstyled widget looks like the owner's site, not ours. */
export const SITE_KEY_ACCENT_DEFAULT = '#111111';

export function isSiteKeyFormat(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(SITE_KEY_PREFIX) &&
    /^[0-9a-f]{32}$/.test(value.slice(SITE_KEY_PREFIX.length))
  );
}

/**
 * One origin, normalised: scheme and host, lower-cased, the default port
 * dropped, path and everything after it refused. Returns null when the line
 * is not an origin. `http` is accepted so a site can be tried on a laptop
 * before it has a certificate.
 */
export function normaliseOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  return url.origin.toLowerCase();
}

/**
 * The allowlist as the owner typed it: one origin per line (commas and
 * whitespace separate too), deduplicated. Null when any line is not an
 * origin, when there are none, or when there are too many -- a form must
 * say which, so the reason is returned with the verdict.
 */
export function parseOrigins(
  input: string,
): { ok: true; origins: string[] } | { ok: false; reason: 'empty' | 'invalid' | 'too_many'; line?: string } {
  const lines = input
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { ok: false, reason: 'empty' };
  const origins: string[] = [];
  for (const line of lines) {
    const origin = normaliseOrigin(line);
    if (!origin) return { ok: false, reason: 'invalid', line };
    if (!origins.includes(origin)) origins.push(origin);
  }
  if (origins.length > SITE_KEY_MAX_ORIGINS) return { ok: false, reason: 'too_many' };
  return { ok: true, origins };
}

/** Whether a parent page at `origin` may embed the widget of this key. */
export function originAllowed(allowed: readonly string[], origin: string | null | undefined): boolean {
  if (!origin) return false;
  const normalised = normaliseOrigin(origin);
  return normalised !== null && allowed.includes(normalised);
}

/** The daily limit from a form field: an integer within the band, else null. */
export function parseDailyLimit(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(number)) return null;
  if (number < SITE_KEY_DAILY_LIMIT_MIN || number > SITE_KEY_DAILY_LIMIT_MAX) return null;
  return number;
}

/** A CSS hex colour, `#rgb` or `#rrggbb`, lower-cased; null otherwise. */
export function parseAccent(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(trimmed) ? trimmed : null;
}

/**
 * The `frame-ancestors` directive for a key: exactly the listed origins.
 * Origins are already normalised, so nothing here needs quoting.
 */
export function frameAncestors(allowed: readonly string[]): string {
  return `frame-ancestors ${allowed.join(' ')}`;
}

/**
 * Whether the widget can answer from an asset right now: published, with a
 * current version. One rule for the dashboard panel and the embed page, so
 * the two never disagree -- a paused (suspended) asset is not ready even
 * when its last version is still indexed.
 */
export function widgetReady(asset: { lifecycleStatus: string; hasCurrentVersion: boolean }): boolean {
  return asset.lifecycleStatus === 'published' && asset.hasCurrentVersion;
}

/** The snippet an owner pastes into their site. */
export function embedSnippet(scriptUrl: string, key: string): string {
  return `<script src="${scriptUrl}" data-site-key="${key}" async></script>`;
}
