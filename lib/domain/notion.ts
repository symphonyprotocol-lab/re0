/**
 * Importing a Notion page into a workspace asset: the rules, as pure
 * functions. No fetch, no Next.js, no driver.
 *
 * Notion cannot be read anonymously, and requirement.md 7.3 says a Notion
 * asset is "created from the person's own authorised connection; the
 * creator is the owner". So the wizard connects the person's Notion account
 * (a public integration, its own consent, like the GitHub one in github.ts),
 * lists the pages that account shared with the integration, and imports one
 * of them with that same grant -- at creation and at every refresh after.
 * The grant is the credential and the proof of ownership at once: the only
 * pages it can read are the ones the person chose to share.
 */

/** What the platform reads from a Notion page record before importing it. */
export interface PageFacts {
  /** Notion's page id, dashed UUID form. */
  id: string;
  title: string;
  /** The page's own `notion.so` URL, as Notion spells it. */
  url: string;
  /** ISO timestamp of the last edit, or null. */
  lastEditedAt: string | null;
  archived: boolean;
}

export const NOTION_IMPORT_REFUSALS = ['not_connected', 'not_found'] as const;
export type NotionImportRefusal = (typeof NOTION_IMPORT_REFUSALS)[number];

/**
 * The 32 hex characters at the end of any Notion URL, as a dashed UUID.
 *
 * Notion puts a human-readable title in front of the id and separates the two
 * with a dash, so the id is recovered from the end rather than by splitting on
 * dashes -- a page called `my-page` would otherwise take the title apart. A
 * bare id, dashed or not, is accepted too: that is what the wizard posts.
 */
export function notionPageId(location: string): string | null {
  const trimmed = location.trim();
  if (trimmed.length === 0) return null;
  let last = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    /* notion.so and notion.site are the classic hosts; the API now hands out
       app.notion.com URLs (`/p/<title>-<id>`), so notion.com is a page host too. */
    if (!/(^|\.)notion\.(so|site|com)$/i.test(url.hostname)) return null;
    last = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
  }
  const match = /([0-9a-f]{32})$/i.exec(last.replace(/-/g, ''));
  if (!match) return null;
  const id = (match[1] ?? '').toLowerCase();
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/** Where the connect flow lands when nothing better is known: the wizard. */
export const NOTION_CONNECT_RETURN_TO = '/dashboard/assets/new';

/** The in-flight connect handshake, sealed in its own short-lived cookie. */
export interface NotionConnectHandshake {
  purpose: 'notion_connect';
  state: string;
  /** Where to land afterwards; an in-app path, validated by the caller. */
  returnTo: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export function isNotionConnectHandshake(value: unknown): value is NotionConnectHandshake {
  if (typeof value !== 'object' || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    h.purpose === 'notion_connect' &&
    typeof h.state === 'string' &&
    typeof h.returnTo === 'string' &&
    typeof h.expiresAt === 'number'
  );
}

/**
 * Outcomes the connect callback can land on, appended to the return path as
 * `?notion=` so the wizard can say what happened. Coarse on purpose: the
 * provider's own message and the state comparison stay in the server log.
 */
export const NOTION_CONNECT_OUTCOMES = ['connected', 'canceled', 'failed'] as const;
export type NotionConnectOutcome = (typeof NOTION_CONNECT_OUTCOMES)[number];

export function isNotionConnectOutcome(value: unknown): value is NotionConnectOutcome {
  return (
    typeof value === 'string' && (NOTION_CONNECT_OUTCOMES as readonly string[]).includes(value)
  );
}

/**
 * The key on `source.config` naming the account whose Notion grant a source
 * is read with. A platform asset has none and is read with the platform's
 * own integration token instead.
 */
export const NOTION_SOURCE_USER_KEY = 'notionUserId';

export function notionSourceUserId(config: Record<string, unknown> | null | undefined): string | null {
  const value = config?.[NOTION_SOURCE_USER_KEY];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
