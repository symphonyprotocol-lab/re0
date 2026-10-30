/**
 * Workspace handles: the public name in `/u/{handle}` and the user Agent Card
 * (agent-first-proposal.md 4.3, 7.1, 12).
 *
 * Lowercase letters, digits and single dashes, 3 to 32 characters, starting
 * and ending with a letter or digit: something that survives a URL path
 * unescaped, reads the same in every font, and cannot be two handles that
 * differ only by case. Reserved names (lib/domain/reserved-names.ts) are
 * refused because handles appear in paths beside the site's own.
 *
 * Pure TypeScript -- domain layer rules apply.
 */
import { isReservedName } from './reserved-names';

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 32;

const HANDLE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,31}$/;

export type HandleRefusal = 'invalid' | 'reserved';

/** Why `value` cannot be a handle, or null when it can. */
export function handleRefusal(value: string): HandleRefusal | null {
  if (!HANDLE.test(value)) return 'invalid';
  if (isReservedName(value)) return 'reserved';
  return null;
}

/** The handle a typed value means, folded to lower case, or null if it cannot be one. */
export function normalizeHandle(value: string): string | null {
  const folded = value.trim().toLowerCase();
  return handleRefusal(folded) === null ? folded : null;
}

/**
 * The handle a new workspace starts with, from what the sign-in knows: the
 * email's local part folded to the handle alphabet, or `user-` plus a few
 * characters of the workspace id when that gives nothing usable. Uniqueness is
 * the caller's (it tries `suffixedHandle` on a collision).
 */
export function suggestHandle(email: string, workspaceId: string): string {
  const local = email.split('@')[0] ?? '';
  const folded = local
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  if (handleRefusal(folded) === null) return folded;
  return `user-${workspaceId.replace(/[^0-9a-f]/gi, '').slice(-6).toLowerCase()}`;
}

/** The `attempt`-th alternative to a taken handle, still within the length limit. */
export function suffixedHandle(base: string, attempt: number, salt: string): string {
  const suffix = `-${salt.replace(/[^0-9a-z]/gi, '').slice(-4).toLowerCase()}${attempt > 1 ? attempt : ''}`;
  return `${base.slice(0, HANDLE_MAX_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`;
}
