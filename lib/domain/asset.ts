/**
 * Data asset types and the access flag. agent-first-proposal.md 3.2, 6.2.
 *
 * An asset is one source's data with immutable versions. Its kind follows
 * from that source; `post`, `audio` and `qa` are the editor and audio kinds
 * that arrive in P3a and P3b, listed now so the column's check and the code
 * agree on one vocabulary from the start.
 *
 * Pure TypeScript -- domain layer rules apply.
 */
import type { SourceType } from './index';

export const ASSET_KINDS = ['website', 'upload', 'github', 'notion', 'post', 'audio', 'qa'] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

/** The kinds a workspace can create today; the rest wait for their phase. */
export const CREATABLE_ASSET_KINDS = ['website', 'upload', 'github', 'notion'] as const satisfies readonly AssetKind[];

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
