/**
 * The owner's rights declaration, as pure rules. requirement.md 7.4 item 1
 * and review-visibility-proposal.md 5.1.
 *
 * A public asset used to be submitted on a checkbox. The declaration is
 * three answers the reviewer's first check needs -- whose content this is,
 * under what licence, and whether a person wrote it -- recorded with who
 * said so and when. It is the owner's statement, not the platform's
 * finding: the reviewer still checks it, and a false one is the owner's
 * responsibility. One answer closes the door by itself: content whose body
 * a model generated without a person's review is not accepted as a public
 * asset (7.4), so that declaration cannot submit.
 */

export const RIGHTS_ORIGINS = ['own', 'licensed', 'other'] as const;
export type RightsOrigin = (typeof RIGHTS_ORIGINS)[number];

export const RIGHTS_LICENSES = ['open_source', 'granted', 'public_domain', 'unsure'] as const;
export type RightsLicense = (typeof RIGHTS_LICENSES)[number];

export const RIGHTS_GENERATIONS = ['human', 'assisted', 'generated'] as const;
export type RightsGeneration = (typeof RIGHTS_GENERATIONS)[number];

export const RIGHTS_NOTE_MAX_LENGTH = 500;

export interface RightsDeclaration {
  origin: RightsOrigin;
  license: RightsLicense;
  generation: RightsGeneration;
  /** The owner's own words on the source, for the reviewer; empty when none. */
  note: string;
  /** ISO instant. */
  declaredAt: string;
  /** The user who declared; null when the actor is not a person (a script, a migration). */
  declaredBy: string | null;
}

function oneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

/** True when the three answers are among the options; nothing else is looked at. */
export function isRightsAnswer(input: { origin?: unknown; license?: unknown; generation?: unknown }): boolean {
  return (
    oneOf(RIGHTS_ORIGINS, input.origin) &&
    oneOf(RIGHTS_LICENSES, input.license) &&
    oneOf(RIGHTS_GENERATIONS, input.generation)
  );
}

/**
 * A declaration as a form posts it. Null when any answer is missing or not
 * one of the options, or the note is unusable -- a half-declaration is
 * refused, not recorded with blanks.
 */
export function parseRightsDeclaration(
  input: { origin?: unknown; license?: unknown; generation?: unknown; note?: unknown },
  by: { userId: string | null; now: Date },
): RightsDeclaration | null {
  if (!oneOf(RIGHTS_ORIGINS, input.origin)) return null;
  if (!oneOf(RIGHTS_LICENSES, input.license)) return null;
  if (!oneOf(RIGHTS_GENERATIONS, input.generation)) return null;
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > RIGHTS_NOTE_MAX_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) return null;
  return {
    origin: input.origin,
    license: input.license,
    generation: input.generation,
    note,
    declaredAt: by.now.toISOString(),
    declaredBy: by.userId,
  };
}

/** Whether a form posted any of the three answers at all: absent is "not declared", not "declared wrong". */
export function rightsPosted(input: { origin?: unknown; license?: unknown; generation?: unknown }): boolean {
  return [input.origin, input.license, input.generation].some((value) => typeof value === 'string' && value.length > 0);
}

/** A stored declaration read back without trusting its shape; null for none or an unreadable one. */
export function readRightsDeclaration(stored: unknown): RightsDeclaration | null {
  if (!stored || typeof stored !== 'object') return null;
  const record = stored as Record<string, unknown>;
  if (!isRightsAnswer(record)) return null;
  return {
    origin: record.origin as RightsOrigin,
    license: record.license as RightsLicense,
    generation: record.generation as RightsGeneration,
    note: typeof record.note === 'string' ? record.note : '',
    declaredAt: typeof record.declaredAt === 'string' ? record.declaredAt : '',
    declaredBy: typeof record.declaredBy === 'string' ? record.declaredBy : null,
  };
}

/**
 * Whether a declaration may back a public asset. requirement.md 7.4:
 * content whose body a model generated without a person's review is not
 * accepted; model-assisted writing a publisher stands behind is.
 */
export function rightsAllowPublic(declaration: RightsDeclaration): boolean {
  return declaration.generation !== 'generated';
}
