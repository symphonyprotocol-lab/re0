/**
 * The shapes a rendering-provider configuration is held to. architecture.md
 * 8.2, 15.1, 15.3.
 *
 * The renderer is the fallback a website build reaches when a site refuses
 * the plain fetch or serves a script shell (`connectors/render.ts`). One
 * provider is in force at a time; each provider keeps its own ordered list of
 * API keys, so switching between vendors and back does not mean re-typing
 * keys, and a key that runs out of quota hands over to the next one.
 *
 * Here rather than in `manage-render-config` because the console form needs
 * the same vocabulary and that module reaches the database. This layer has
 * no imports at all, so it is the one both sides can share.
 */

export const RENDER_PROVIDERS = ['firecrawl', 'anysearch', 'jina'] as const;
export type RenderProviderName = (typeof RENDER_PROVIDERS)[number];

export function isRenderProvider(value: unknown): value is RenderProviderName {
  return typeof value === 'string' && (RENDER_PROVIDERS as readonly string[]).includes(value);
}

/** Each vendor's hosted API -- what a configuration without a base URL calls. */
export const DEFAULT_RENDER_BASE_URL: Record<RenderProviderName, string> = {
  firecrawl: 'https://api.firecrawl.dev',
  anysearch: 'https://api.anysearch.com',
  jina: 'https://r.jina.ai',
};

/**
 * Whether the vendor's hosted API answers without a key. Firecrawl refuses
 * anonymous calls; AnySearch and Jina serve a small anonymous quota per
 * client address, which is enough for a trial and not for a build.
 */
export function hostedRequiresKey(provider: RenderProviderName): boolean {
  return provider === 'firecrawl';
}

/** How many keys one provider may hold. A list is a pool, not a vault. */
export const RENDER_KEYS_MAX = 20;

/** Same ceiling as the model registry's credentials. */
export const RENDER_KEY_MAX_LENGTH = 512;

/**
 * Why a key stopped answering, as the provider said it.
 *
 * - `exhausted`: 402, the quota or balance behind the key is spent;
 * - `rejected`: 401, the key is invalid -- and for AnySearch also 403, which
 *   it answers for an expired key or a disabled account.
 *
 * Firecrawl's 403 is not about the key: it is the vendor declining to scrape
 * that one site. Counting it against the key would set a healthy pool aside,
 * key by key, on the first site Firecrawl does not support.
 *
 * A 429 is neither: it is this minute's rate limit, so the build moves to the
 * next key for the rest of its run but records nothing against the key.
 */
export type RenderKeyFailure = 'exhausted' | 'rejected';

export function keyFailureOf(
  provider: RenderProviderName,
  status: number | undefined,
): RenderKeyFailure | 'rate_limited' | null {
  if (status === 402) return 'exhausted';
  if (status === 401) return 'rejected';
  if (status === 403 && provider === 'anysearch') return 'rejected';
  if (status === 429) return 'rate_limited';
  return null;
}

/**
 * How long a failed key goes to the back of the line.
 *
 * A key is never switched off by a build: quotas reset (daily for some
 * vendors, monthly for others) and the provider does not tell us when. So a
 * failed key is tried after the healthy ones until this passes, and is still
 * tried last before a build gives up -- which is how a quota that came back
 * is discovered without anybody pressing a button.
 */
export const RENDER_KEY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Whether a base URL may be saved: http(s), no credentials in it.
 *
 * Plain http is allowed because the normal self-hosted case is an instance on
 * the private network (`http://firecrawl:3002`). It is safe because stored
 * keys are only ever sent to the vendor's own hosted API, never to a base URL
 * an operator typed (`render.ts`, `manage-render-config.ts`).
 */
export function normalizeRenderBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, '');
}
