/**
 * Data asset types and the access flag. agent-first-proposal.md 3.2, 6.2.
 *
 * An asset is one source's data with immutable versions. Its kind follows
 * from that source; `post` and `qa` come from the platform's own editor
 * (an `editor` source) and `audio` from an uploaded episode (P3a, P3b).
 *
 * Pure TypeScript -- domain layer rules apply.
 */
import type { SourceType } from './index';

export const ASSET_KINDS = ['website', 'upload', 'github', 'notion', 'post', 'audio', 'qa'] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * The kinds the asset wizard creates. `post` and `audio` start there as
 * drafts and are written in their editor (lib/application/editorial); a
 * `qa` is made by answering a question, never directly.
 */
export const CREATABLE_ASSET_KINDS = ['website', 'upload', 'github', 'notion', 'post', 'audio'] as const satisfies readonly AssetKind[];

export function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === 'string' && (ASSET_KINDS as readonly string[]).includes(value);
}

/** The kind a source makes: the two upload formats are one kind. */
export function assetKindOf(sourceType: SourceType): AssetKind {
  switch (sourceType) {
    case 'github':
      return 'github';
    case 'website':
      return 'website';
    case 'notion':
      return 'notion';
    case 'pdf':
    case 'markdown':
      return 'upload';
    /* An editor source is an article or a Q&A; its creator says which. */
    case 'editor':
      return 'post';
    case 'audio':
      return 'audio';
  }
}

/**
 * Kinds whose source lives somewhere the owner has to prove control of before
 * the asset may sit in a public channel (proposal 6.11, requirement.md 7.3).
 * The rest are declared by their creator (7.1).
 */
export const CLAIMED_ASSET_KINDS: readonly AssetKind[] = ['website', 'github'];

export function needsClaimForPublic(kind: AssetKind): boolean {
  return CLAIMED_ASSET_KINDS.includes(kind);
}

export const ASSET_ACCESS = ['free', 'paid'] as const;

export type AssetAccess = (typeof ASSET_ACCESS)[number];

export function isAssetAccess(value: unknown): value is AssetAccess {
  return value === 'free' || value === 'paid';
}
