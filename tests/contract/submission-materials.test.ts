/**
 * What a public submission brings (review-visibility-proposal.md 5): the
 * rights declaration (lib/domain/rights.ts) and the question set, and how
 * their absence holds a public library back from the review queue
 * (lib/domain/library.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  lifecycleAfterBuild,
  ownerActionAvailable,
  reviewPipeline,
  submissionBlockers,
  submissionReady,
  visibilityTransition,
} from '@/lib/domain/library';
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

describe('submission materials', () => {
  it('asks for the declaration alone; the question set is the expert gate\'s (2026-10-23)', () => {
    expect(submissionBlockers({ rightsDeclared: false, rightsAllowPublic: false })).toEqual(['rights']);
    expect(submissionBlockers({ rightsDeclared: true, rightsAllowPublic: false })).toEqual(['rights_generated']);
    expect(submissionBlockers({ rightsDeclared: true, rightsAllowPublic: true })).toEqual([]);
    expect(submissionReady({ rightsDeclared: true, rightsAllowPublic: true })).toBe(true);
  });

  it('leaves a public build for its owner to submit, and publishes a private one', () => {
    const base = { lifecycleStatus: 'draft' as const, isPlatformLibrary: false };
    expect(lifecycleAfterBuild({ ...base, visibility: 'public' })).toBeNull();
    expect(lifecycleAfterBuild({ ...base, lifecycleStatus: 'changes_requested', visibility: 'public' })).toBeNull();
    expect(lifecycleAfterBuild({ ...base, visibility: 'private' })).toBe('published');
  });

  it("offers the owner's submit once a held draft is ready, and a resubmit only when ready", () => {
    const held = { lifecycleStatus: 'draft' as const, visibility: 'public' as const, pausedByOwner: false, hasReadyVersion: true };
    expect(ownerActionAvailable({ ...held, materialsReady: false }, 'submit')).toBe(false);
    expect(ownerActionAvailable({ ...held, materialsReady: true }, 'submit')).toBe(true);
    expect(ownerActionAvailable({ ...held, hasReadyVersion: false, materialsReady: true }, 'submit')).toBe(false);
    expect(ownerActionAvailable({ ...held, visibility: 'private', materialsReady: true }, 'submit')).toBe(false);
    const returned = { ...held, lifecycleStatus: 'changes_requested' as const };
    expect(ownerActionAvailable({ ...returned, materialsReady: false }, 'resubmit')).toBe(false);
    expect(ownerActionAvailable({ ...returned, materialsReady: true }, 'resubmit')).toBe(true);
    expect(ownerActionAvailable(returned, 'resubmit')).toBe(true);
  });

  it('parks a live library that goes public in draft for its owner to submit, never live', () => {
    const live = { from: 'private' as const, to: 'public' as const, lifecycleStatus: 'published' as const, hasReadyVersion: true };
    expect(visibilityTransition(live)).toBe('draft');
  });

  it('shows the materials step for a public library only, active once the build is done', () => {
    const input = { visibility: 'public' as const, lifecycleStatus: 'draft' as const, indexStatus: 'ready' as const, building: false };
    expect(reviewPipeline(input).map((entry) => entry.step)).toEqual(['rights', 'parse', 'safety', 'materials', 'review', 'publish']);
    expect(reviewPipeline(input).find((entry) => entry.step === 'materials')?.state).toBe('active');
    expect(reviewPipeline({ ...input, indexStatus: 'pending' }).find((entry) => entry.step === 'materials')?.state).toBe('pending');
    expect(reviewPipeline({ ...input, lifecycleStatus: 'submitted' }).find((entry) => entry.step === 'materials')?.state).toBe('done');
    expect(reviewPipeline({ ...input, visibility: 'private' }).map((entry) => entry.step)).toEqual(['rights', 'parse', 'safety', 'publish']);
  });

  it('blocks the pipeline’s rights step until the declaration is in', () => {
    const input = { visibility: 'public' as const, lifecycleStatus: 'draft' as const, indexStatus: 'ready' as const, building: false };
    expect(reviewPipeline({ ...input, rightsDeclared: false })[0]).toEqual({ step: 'rights', state: 'blocked' });
    expect(reviewPipeline({ ...input, rightsDeclared: true })[0]).toEqual({ step: 'rights', state: 'done' });
    expect(reviewPipeline(input)[0]).toEqual({ step: 'rights', state: 'done' });
  });
});
