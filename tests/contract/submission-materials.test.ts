/**
 * The owner's rights declaration (review-visibility-proposal.md 5.1,
 * lib/domain/rights.ts): what it records, and what it permits.
 */
import { describe, expect, it } from 'vitest';
import {
  parseRightsDeclaration,
  readRightsDeclaration,
  RIGHTS_NOTE_MAX_LENGTH,
  rightsAllowPublic,
  rightsPosted,
} from '@/lib/domain/rights';

const now = new Date('2026-10-21T08:00:00Z');
const answer = { origin: 'own', license: 'open_source', generation: 'human', note: '  our own docs ' };

describe('rights declaration', () => {
  it('records the three answers, the note, who and when', () => {
    const declared = parseRightsDeclaration(answer, { userId: 'user-1', now });
    expect(declared).toEqual({
      origin: 'own',
      license: 'open_source',
      generation: 'human',
      note: 'our own docs',
      declaredAt: now.toISOString(),
      declaredBy: 'user-1',
    });
    expect(readRightsDeclaration(JSON.parse(JSON.stringify(declared)))).toEqual(declared);
  });

  it('refuses a missing or unknown answer and an oversized note, and reads nothing from a broken row', () => {
    expect(parseRightsDeclaration({ ...answer, license: undefined }, { userId: null, now })).toBeNull();
    expect(parseRightsDeclaration({ ...answer, origin: 'stolen' }, { userId: null, now })).toBeNull();
    expect(parseRightsDeclaration({ ...answer, note: 'x'.repeat(RIGHTS_NOTE_MAX_LENGTH + 1) }, { userId: null, now })).toBeNull();
    expect(readRightsDeclaration(null)).toBeNull();
    expect(readRightsDeclaration({ origin: 'own' })).toBeNull();
  });

  it('tells a form that posted nothing from one that posted wrong', () => {
    expect(rightsPosted({})).toBe(false);
    expect(rightsPosted({ origin: '', license: '', generation: '' })).toBe(false);
    expect(rightsPosted({ origin: 'own' })).toBe(true);
  });

  it('does not let model-generated content back a public library (7.4)', () => {
    const generated = parseRightsDeclaration({ ...answer, generation: 'generated' }, { userId: null, now })!;
    const assisted = parseRightsDeclaration({ ...answer, generation: 'assisted' }, { userId: null, now })!;
    expect(rightsAllowPublic(generated)).toBe(false);
    expect(rightsAllowPublic(assisted)).toBe(true);
  });
});
