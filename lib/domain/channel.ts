/**
 * Channel rules, as pure functions. agent-first-proposal.md 6.1-6.4.
 *
 * A channel groups assets of any kind and is the only way an asset is shown
 * to anyone but its owner. An asset is in no channel or in exactly one;
 * leaving resets its `access` to free. A channel is public by default and may
 * be private; the platform may suspend it.
 *
 * Pure TypeScript -- domain layer rules apply.
 */
import type { AssetAccess } from './asset';

export const CHANNEL_VISIBILITIES = ['public', 'private'] as const;
export type ChannelVisibility = (typeof CHANNEL_VISIBILITIES)[number];

export const CHANNEL_STATUSES = ['active', 'suspended'] as const;
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** The slug of the platform's own channel, which holds the platform assets. */
export const PLATFORM_CHANNEL_SLUG = 're0';
/** Its fixed row id, written by migration 0062. */
export const PLATFORM_CHANNEL_ID = '01920000-0000-7000-8000-0000000000c1';

export const CHANNEL_TITLE_MAX_LENGTH = 80;
export const CHANNEL_DESCRIPTION_MAX_LENGTH = 400;

/**
 * A channel slug: the `{slug}` of `/channels/{slug}` and of the channel card's
 * tenant. Same alphabet as a handle, 3 to 48 characters; slugs live under
 * `/channels/`, so the root's reserved names do not apply, only the
 * platform's own.
 */
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,47}$/;

export function isChannelVisibility(value: unknown): value is ChannelVisibility {
  return value === 'public' || value === 'private';
}

export function normalizeChannelSlug(value: string): string | null {
  const folded = value.trim().toLowerCase();
  if (!SLUG.test(folded)) return null;
  if (folded === PLATFORM_CHANNEL_SLUG) return null;
  return folded;
}

/** The slug a title suggests; '' when the title has nothing usable (a Chinese title, say). */
export function channelSlugFromTitle(title: string): string {
  const folded = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return normalizeChannelSlug(folded) ?? '';
}

export class ChannelRefused extends Error {
  constructor(
    readonly code:
      | 'invalid_slug'
      | 'slug_taken'
      | 'invalid_title'
      | 'invalid_description'
      | 'not_found'
      | 'not_owner'
      | 'asset_not_found'
      | 'asset_not_ready'
      | 'claim_required'
      | 'rights_required'
      | 'suspended',
    message: string,
  ) {
    super(message);
    this.name = 'ChannelRefused';
  }
}

export interface ChannelDraft {
  slug: string;
  title: string;
  description: string | null;
  visibility: ChannelVisibility;
}

/** A validated create or edit, or a refusal naming the field. */
export function draftChannel(input: {
  slug: string;
  title: string;
  description?: string | null;
  visibility?: string;
}): ChannelDraft {
  const slug = normalizeChannelSlug(input.slug);
  if (!slug) throw new ChannelRefused('invalid_slug', 'a channel slug is 3-48 lowercase letters, digits or dashes');
  const title = input.title.trim();
  if (title.length === 0 || title.length > CHANNEL_TITLE_MAX_LENGTH) {
    throw new ChannelRefused('invalid_title', 'a channel needs a title');
  }
  const description = input.description?.trim() || null;
  if (description && description.length > CHANNEL_DESCRIPTION_MAX_LENGTH) {
    throw new ChannelRefused('invalid_description', 'the description is too long');
  }
  const visibility = isChannelVisibility(input.visibility) ? input.visibility : 'public';
  return { slug, title, description, visibility };
}

/* ------------------------------------------------------------- visibility */

/**
 * How much of an asset a caller may see (proposal 6.2):
 *
 * | where the asset is        | access | owner | subscriber | anyone else |
 * | in no channel             | --     | full  | none       | none        |
 * | in a private channel      | --     | full  | none       | none        |
 * | in a public channel       | free   | full  | full       | full        |
 * | in a public channel       | paid   | full  | full       | summary     |
 *
 * `summary` is title, description and publication time -- never a chunk. A
 * suspended channel shows nothing to anyone but its owner. P1 has no
 * subscriptions, so `isSubscriber` is always false until P3a.
 */
export type AssetSight = 'full' | 'summary' | 'none';

export function assetSight(input: {
  isOwner: boolean;
  isSubscriber?: boolean;
  channel: { visibility: ChannelVisibility; status: ChannelStatus } | null;
  access: AssetAccess;
}): AssetSight {
  if (input.isOwner) return 'full';
  const channel = input.channel;
  if (!channel || channel.visibility !== 'public' || channel.status !== 'active') return 'none';
  if (input.access === 'free') return 'full';
  return input.isSubscriber ? 'full' : 'summary';
}

/* -------------------------------------------------------------- directory */

/** Proposal 6.4 and the console's retrieval settings: weights in basis points. */
export interface DirectoryWeights {
  activityBps: number;
  freshnessBps: number;
  qualityBps: number;
  halfLifeDays: number;
}

export const DEFAULT_DIRECTORY_WEIGHTS: DirectoryWeights = {
  activityBps: 5_000,
  freshnessBps: 2_500,
  qualityBps: 2_500,
  halfLifeDays: 14,
};

/** The window activity is counted over; `POPULARITY_WINDOW_DAYS` in proposal 6.4. */
export const ACTIVITY_WINDOW_DAYS = 30;

export interface ChannelActivity {
  /** Distinct signed-in readers in the window, owner excluded. */
  users: number;
  /** Distinct calling workspaces over A2A or REST. */
  workspaces: number;
  /** Distinct anonymous visitors, by the hashed rate-limit key. */
  anonymous: number;
}

/**
 * The raw activity term before normalisation: each kind of visitor counted on
 * a log scale, then summed. People, not calls -- one caller hammering a
 * channel counts once a day, so it cannot buy rank.
 */
export function rawActivity(activity: ChannelActivity): number {
  return Math.log1p(activity.users) + Math.log1p(activity.workspaces) + Math.log1p(activity.anonymous);
}

/** 1 for a channel updated now, halving every `halfLifeDays`. */
export function freshness(lastUpdatedAt: Date | null, now: Date, halfLifeDays: number): number {
  if (!lastUpdatedAt) return 0;
  const days = Math.max(0, (now.getTime() - lastUpdatedAt.getTime()) / 86_400_000);
  return Math.pow(0.5, days / Math.max(1, halfLifeDays));
}

/** Mean of (Trust + Benchmark) / 200 over the channel's assets, in 0-1. */
export function quality(scores: readonly { trust: number; benchmark: number }[]): number {
  if (scores.length === 0) return 0;
  const sum = scores.reduce((total, score) => total + (score.trust + score.benchmark) / 200, 0);
  return Math.min(1, Math.max(0, sum / scores.length));
}

export interface DirectoryEntryFacts {
  id: string;
  activity: ChannelActivity;
  lastUpdatedAt: Date | null;
  scores: readonly { trust: number; benchmark: number }[];
}

/**
 * 热门: `score = wa * activity + wf * freshness + wq * quality`, every term in
 * 0-1. Activity is normalised against the busiest channel in the set, so the
 * scores are relative to the directory being ranked. Subscriptions and
 * revenue are deliberately not inputs (proposal 6.4).
 */
export function hotScores(
  entries: readonly DirectoryEntryFacts[],
  now: Date,
  weights: DirectoryWeights = DEFAULT_DIRECTORY_WEIGHTS,
): Map<string, number> {
  const raw = entries.map((entry) => rawActivity(entry.activity));
  const top = Math.max(0, ...raw);
  const scores = new Map<string, number>();
  entries.forEach((entry, at) => {
    const activity = top > 0 ? raw[at]! / top : 0;
    const score =
      (weights.activityBps / 10_000) * activity +
      (weights.freshnessBps / 10_000) * freshness(entry.lastUpdatedAt, now, weights.halfLifeDays) +
      (weights.qualityBps / 10_000) * quality(entry.scores);
    scores.set(entry.id, score);
  });
  return scores;
}

export const DIRECTORY_SORTS = ['hot', 'recent'] as const;
export type DirectorySort = (typeof DIRECTORY_SORTS)[number];

export function isDirectorySort(value: unknown): value is DirectorySort {
  return value === 'hot' || value === 'recent';
}
