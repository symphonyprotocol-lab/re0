/**
 * Comments, as pure rules. agent-first-proposal.md 6.8.
 *
 * A comment is a reader's interaction with one asset in a channel. It is not
 * an asset: it has no version, is never retrieved, never evidence for the
 * twin, never anchored. Who may comment and who may read follow from where
 * the asset is and its `access`:
 *
 * | where the asset is        | access | may comment                  | may read                 |
 * | in no or a private channel| --     | nobody                       | nobody                   |
 * | in a public channel       | free   | any signed-in user           | everyone                 |
 * | in a public channel       | paid   | subscribers and the creator  | subscribers and creator  |
 *
 * plus the creator's own switch to close comments on one asset, and the
 * channel's suspension, which closes everything.
 *
 * Pure TypeScript -- domain layer rules apply.
 */
import type { AssetAccess } from './asset';
import type { ChannelStatus, ChannelVisibility } from './channel';

export const COMMENT_STATES = ['visible', 'hidden', 'deleted', 'removed'] as const;
export type CommentState = (typeof COMMENT_STATES)[number];

export const COMMENT_LIMITS = {
  bodyMax: 2_000,
  /** At most this many comments per author per window -- a person typing, not a script. */
  rateCount: 5,
  rateWindowSeconds: 60,
  /** And this many in a day. */
  dailyCount: 100,
  reportReasonMax: 300,
} as const;

/** What a deleted comment shows in its place (proposal 6.8). */
export const DELETED_COMMENT_PLACEHOLDER = '[deleted]';

export interface CommentContext {
  channel: { visibility: ChannelVisibility; status: ChannelStatus } | null;
  access: AssetAccess;
  commentsClosed: boolean;
}

export interface CommentViewer {
  signedIn: boolean;
  isOwner: boolean;
  isSubscriber: boolean;
}

/** Whether the asset has a comment section at all. */
export function commentsOpenOn(context: Pick<CommentContext, 'channel'>): boolean {
  return context.channel?.visibility === 'public' && context.channel.status === 'active';
}

/** Whether this viewer may read the asset's comments. */
export function mayReadComments(context: CommentContext, viewer: CommentViewer): boolean {
  if (!commentsOpenOn(context)) return false;
  if (context.access === 'free') return true;
  return viewer.isOwner || viewer.isSubscriber;
}

/** Whether this viewer may write one (or reply). Closed comments stop everyone but the creator. */
export function mayWriteComment(context: CommentContext, viewer: CommentViewer): boolean {
  if (!viewer.signedIn || !commentsOpenOn(context)) return false;
  if (context.commentsClosed && !viewer.isOwner) return false;
  if (context.access === 'free') return true;
  return viewer.isOwner || viewer.isSubscriber;
}

export class CommentRefused extends Error {
  constructor(
    readonly code:
      | 'not_allowed'
      | 'not_found'
      | 'invalid_body'
      | 'rate_limited'
      | 'reply_depth'
      | 'not_owner'
      | 'not_author'
      | 'already_reported',
    message: string,
  ) {
    super(message);
    this.name = 'CommentRefused';
  }
}

/** The body as stored: trimmed, control characters out, within the limit. */
export function normalizeCommentBody(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() : '';
  if (text.length === 0 || text.length > COMMENT_LIMITS.bodyMax) {
    throw new CommentRefused('invalid_body', `a comment is 1 to ${COMMENT_LIMITS.bodyMax} characters`);
  }
  return text;
}

/**
 * A comment's text in renderable pieces: plain text and links. Nothing in a
 * comment is ever rendered as markup (it is untrusted content); a URL becomes
 * a link the page marks `nofollow ugc` and flags as external.
 */
export type CommentPiece = { kind: 'text'; text: string } | { kind: 'link'; href: string; text: string };

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;

export function commentPieces(body: string): CommentPiece[] {
  const pieces: CommentPiece[] = [];
  let at = 0;
  for (const match of body.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(/[.,;:!?)\]]+$/, '');
    const start = match.index ?? 0;
    if (start > at) pieces.push({ kind: 'text', text: body.slice(at, start) });
    let href: string | null = null;
    try {
      const url = new URL(raw);
      href = url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      href = null;
    }
    pieces.push(href ? { kind: 'link', href, text: raw } : { kind: 'text', text: raw });
    at = start + raw.length;
  }
  if (at < body.length) pieces.push({ kind: 'text', text: body.slice(at) });
  return pieces;
}
