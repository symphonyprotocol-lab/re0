/**
 * Site-wide traffic (console 「流量」): what a page view is, which page it
 * is, where its visit came from. Pure, so the beacon route, the rollup and
 * the tests share one definition.
 *
 * - a page view is one open of a page that uses the root layout, or one
 *   client-side move to a new route; `/admin/**` and API paths are never
 *   counted;
 * - its path is stored without the query (only the three utm values are
 *   kept) and without the language prefix of a localized page, so
 *   `/en/pricing` and `/pricing` are one page;
 * - a visit is a visitor's activity with no gap longer than
 *   `TRAFFIC_VISIT_SECONDS` (the share page's half hour). Its first page is
 *   the landing page, and its source -- `utm_source` first, then the
 *   referrer's host -- is decided there; later views inherit it.
 */
import { isLocalizedPath, splitLocale } from '@/i18n/paths';

/** A gap longer than this between two views of one visitor starts a new visit. */
export const TRAFFIC_VISIT_SECONDS = 1_800;
/** Raw page views are kept this long; older days live on in the daily rollup. */
export const TRAFFIC_RETENTION_DAYS = 90;
/** Longest stored path; a longer one is not a page of this site. */
export const TRAFFIC_PATH_MAX = 300;
/** Longest stored utm value or source label. */
export const TRAFFIC_LABEL_MAX = 100;

export const PAGE_KINDS = ['home', 'ree', 'share', 'explore', 'post', 'pricing', 'about', 'legal', 'login', 'workspace', 'other'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** Classes a source falls in; `internal` is a visit that began on this site (a client move after a long pause). */
export const SOURCE_CHANNELS = ['direct', 'social', 'search', 'referral', 'campaign', 'internal'] as const;
export type SourceChannel = (typeof SOURCE_CHANNELS)[number];

/** The source labels of visits with no outside origin. */
export const DIRECT_SOURCE = 'direct';
export const INTERNAL_SOURCE = 'internal';

/** First path segments of the signed-in workspace (app/(product)/(workspace)). */
const WORKSPACE_ROOTS = new Set(['activities', 'chats', 'dashboard', 'me', 'notifications', 'rees', 'saved', 'settings', 'talk', 'videos', 'workspace', 'checkout', 'billing', 'redeem']);
/** Never counted: the console, API routes, Next's own files and media. */
const EXCLUDED_ROOTS = new Set(['admin', 'api', '_next', 'media', 'video']);

export interface TrackedPath {
  path: string;
  kind: PageKind;
}

/**
 * The page a beacon reports, as it is stored, or null when it is not
 * counted: not a path, too long, the console or an API route. The query
 * and hash go; a localized page loses its language prefix; a Ree's or a
 * share page's slug is lower-cased (slugs are matched case-insensitively).
 */
export function trackedPath(raw: unknown): TrackedPath | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return null;
  const cut = raw.search(/[?#]/);
  let path = cut === -1 ? raw : raw.slice(0, cut);
  if (path.length > TRAFFIC_PATH_MAX || /[\s\\]/.test(path)) return null;
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  const localized = splitLocale(path);
  if (localized && isLocalizedPath(localized.path)) path = localized.path;
  const segments = path.split('/').filter(Boolean);
  const [root = '', second] = segments;
  if (EXCLUDED_ROOTS.has(root.toLowerCase())) return null;
  if ((root === 'r' || root === 's') && second && segments.length === 2) path = `/${root}/${second.toLowerCase()}`;
  return { path, kind: pageKind(segments) };
}

function pageKind(segments: string[]): PageKind {
  const [root, second] = segments;
  if (!root) return 'home';
  if (root === 'r' && second && segments.length === 2) return 'ree';
  if (root === 's' && second && segments.length === 2) return 'share';
  if (root === 'p' && second && segments.length === 2) return 'post';
  if (root === 'explore') return 'explore';
  if (root === 'pricing') return 'pricing';
  if (root === 'about') return 'about';
  if (root === 'legal') return 'legal';
  if (root === 'login') return 'login';
  if (WORKSPACE_ROOTS.has(root)) return 'workspace';
  return 'other';
}

/** Known sources: a label, its class, and the hosts (or Android app ids) that mean it. */
const KNOWN_SOURCES: { source: string; channel: SourceChannel; hosts: readonly string[]; labels?: readonly string[]; pattern?: RegExp }[] = [
  { source: 'twitter', channel: 'social', hosts: ['t.co', 'twitter.com', 'x.com', 'com.twitter.android'], labels: ['x', 'tw', 'twitter.com', 'x.com', 't.co'] },
  { source: 'google', channel: 'search', hosts: ['com.google.android.googlequicksearchbox', 'com.google.android.gm'], pattern: /(^|\.)google\.[a-z.]{2,7}$/ },
  { source: 'bing', channel: 'search', hosts: ['bing.com'] },
  { source: 'duckduckgo', channel: 'search', hosts: ['duckduckgo.com'] },
  { source: 'baidu', channel: 'search', hosts: ['baidu.com'] },
  { source: 'yandex', channel: 'search', hosts: [], pattern: /(^|\.)yandex\.[a-z.]{2,7}$/ },
  { source: 'yahoo', channel: 'search', hosts: ['yahoo.com', 'yahoo.co.jp'] },
  { source: 'github', channel: 'referral', hosts: ['github.com', 'github.io'] },
  { source: 'linkedin', channel: 'social', hosts: ['linkedin.com', 'lnkd.in', 'com.linkedin.android'] },
  { source: 'facebook', channel: 'social', hosts: ['facebook.com', 'fb.com', 'com.facebook.katana'] },
  { source: 'reddit', channel: 'social', hosts: ['reddit.com', 'com.reddit.frontpage'] },
  { source: 'hackernews', channel: 'social', hosts: ['news.ycombinator.com'], labels: ['hn'] },
  { source: 'producthunt', channel: 'social', hosts: ['producthunt.com'] },
  { source: 'youtube', channel: 'social', hosts: ['youtube.com', 'youtu.be'] },
  { source: 'threads', channel: 'social', hosts: ['threads.net', 'threads.com'] },
  { source: 'bluesky', channel: 'social', hosts: ['bsky.app'] },
  { source: 'weibo', channel: 'social', hosts: ['weibo.com', 'weibo.cn'] },
  { source: 'zhihu', channel: 'social', hosts: ['zhihu.com'] },
  { source: 'v2ex', channel: 'social', hosts: ['v2ex.com'] },
  { source: 'chatgpt', channel: 'referral', hosts: ['chatgpt.com', 'chat.openai.com'] },
  { source: 'perplexity', channel: 'referral', hosts: ['perplexity.ai'] },
];

function hostMatches(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

function knownByHost(host: string) {
  return KNOWN_SOURCES.find((known) => known.hosts.some((base) => hostMatches(host, base)) || known.pattern?.test(host));
}

/** The class a stored source label is in: a known one's, a host's (`referral`), or a campaign's (`utm_source` we do not know). */
export function channelOf(source: string): SourceChannel {
  if (source === DIRECT_SOURCE) return 'direct';
  if (source === INTERNAL_SOURCE) return 'internal';
  const known = KNOWN_SOURCES.find((entry) => entry.source === source);
  if (known) return known.channel;
  return source.includes('.') ? 'referral' : 'campaign';
}

/** A host as a label: lower case, no `www.` / `m.` / `mobile.` in front. */
function hostLabel(host: string): string {
  return host.toLowerCase().replace(/^(www|m|mobile)\./, '');
}

/** A referrer's host (an Android app's package for `android-app://`), or null when there is none or it is not a URL. */
export function referrerHost(referrer: unknown): string | null {
  if (typeof referrer !== 'string' || !referrer.trim()) return null;
  try {
    const url = new URL(referrer.trim());
    if (url.protocol === 'android-app:') return url.hostname.toLowerCase() || null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** A utm value as stored: trimmed, lower-cased for the source, cut to `TRAFFIC_LABEL_MAX`; blank → null. */
export function utmValue(value: unknown, lower = false): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, TRAFFIC_LABEL_MAX);
  if (!trimmed) return null;
  return lower ? trimmed.toLowerCase() : trimmed;
}

export interface SourceInput {
  referrer?: unknown;
  utmSource?: unknown;
  /** This site's hosts: a referrer from one of them is navigation, not a source. */
  ownHosts: readonly string[];
}

export interface Source {
  source: string;
  channel: SourceChannel;
  /** The referrer's host as received, or null (stored for the record; never the full URL). */
  referrerHost: string | null;
}

/**
 * Where a visit came from. `utm_source` wins (so a shared link still counts
 * as Twitter when the app strips the referrer); otherwise the referrer's
 * host: known ones by name, this site's own as `internal`, none as
 * `direct`, any other by its host, as a `referral`.
 */
export function classifySource(input: SourceInput): Source {
  const host = referrerHost(input.referrer);
  const own = host !== null && input.ownHosts.some((ownHost) => ownHost.toLowerCase() === host);
  const utm = utmValue(input.utmSource, true);
  if (utm) {
    const known = KNOWN_SOURCES.find((entry) => entry.source === utm || entry.labels?.includes(utm)) ?? knownByHost(hostLabel(utm));
    const source = known?.source ?? utm;
    return { source, channel: known?.channel ?? channelOf(source), referrerHost: host };
  }
  if (!host) return { source: DIRECT_SOURCE, channel: 'direct', referrerHost: null };
  if (own) return { source: INTERNAL_SOURCE, channel: 'internal', referrerHost: host };
  const known = knownByHost(host);
  if (known) return { source: known.source, channel: known.channel, referrerHost: host };
  const label = hostLabel(host).slice(0, TRAFFIC_LABEL_MAX);
  return { source: label, channel: 'referral', referrerHost: host };
}

/** The visitor's last page view, as the visit rule needs it. */
export interface LastView {
  at: Date;
  source: string;
}

/**
 * The visit a page view belongs to: the visitor's open one (last view no
 * more than `TRAFFIC_VISIT_SECONDS` ago), inheriting its source, or a new
 * one that lands here with `arrived` as its source.
 */
export function visitOf(last: LastView | null, arrived: Source, now: Date): { landing: boolean; source: string } {
  const open = last !== null && now.getTime() - last.at.getTime() <= TRAFFIC_VISIT_SECONDS * 1_000 && now.getTime() >= last.at.getTime() - 60_000;
  if (open) return { landing: false, source: last.source };
  return { landing: true, source: arrived.source };
}

/**
 * User agents that are not a person's browser: crawlers, link-preview
 * fetchers (Twitterbot, Slack, Discord …), headless browsers and HTTP
 * libraries. A missing user agent counts as one. Nothing about the agent is
 * stored either way.
 */
const BOT_AGENT = /bot\b|bot\/|crawl|spider|slurp|scrap|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|curl\/|wget|python|httpclient|okhttp|go-http|axios|node-fetch|undici|java\/|libwww|feed|^mozilla\/5\.0$/i;

export function isBotAgent(agent: string | null | undefined): boolean {
  if (!agent || agent.trim().length < 10) return true;
  return BOT_AGENT.test(agent);
}
