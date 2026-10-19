/**
 * Routing admission and retrieval confirmation, as decisions. architecture.md
 * 9.6: recall returns its nearest neighbours whatever the distance, so the
 * judgement of whether a library is about the question at all lives here.
 */
import { describe, expect, it } from 'vitest';
import {
  admitsCandidate,
  CENTROID_ADMIT_DISTANCE,
  CHUNK_CONFIRM_DISTANCE,
  CHUNK_LOOSE_DISTANCE,
  confirmsRetrieval,
  strongKeywordEvidence,
} from '@/lib/domain/routing';

const nothing = { profileRank: 0, centroidDistance: null, rareTerms: 0, nameHint: false };

describe('candidate admission', () => {
  it('refuses a candidate no path found evidence for', () => {
    expect(admitsCandidate(nothing)).toBe(false);
    /* The nearest centroid of a one-library platform is not evidence. */
    expect(admitsCandidate({ ...nothing, centroidDistance: 0.9 })).toBe(false);
    expect(admitsCandidate({ ...nothing, centroidDistance: CENTROID_ADMIT_DISTANCE + 0.01 })).toBe(
      false,
    );
  });

  it('admits on a profile term, a rare term, a name hint, or a close centroid', () => {
    expect(admitsCandidate({ ...nothing, profileRank: 0.001 })).toBe(true);
    expect(admitsCandidate({ ...nothing, rareTerms: 1 })).toBe(true);
    expect(admitsCandidate({ ...nothing, nameHint: true })).toBe(true);
    expect(admitsCandidate({ ...nothing, centroidDistance: CENTROID_ADMIT_DISTANCE })).toBe(true);
    expect(admitsCandidate({ ...nothing, centroidDistance: 0.33 })).toBe(true);
  });
});

describe('retrieval confirmation', () => {
  it('trusts keyword recall when no vector leg ran', () => {
    expect(confirmsRetrieval({ bestDistance: null, keywordHits: 1 }, { crossScript: false })).toBe(true);
    expect(confirmsRetrieval({ bestDistance: null, keywordHits: 0 }, { crossScript: false })).toBe(false);
  });

  it('judges by the best chunk distance when a vector leg ran, keyword hits or not', () => {
    /* An ORM question hits "transaction" in any corpus; that is not context. */
    expect(confirmsRetrieval({ bestDistance: 0.575, keywordHits: 12 }, { crossScript: false })).toBe(
      false,
    );
    expect(confirmsRetrieval({ bestDistance: 0.34, keywordHits: 0 }, { crossScript: false })).toBe(true);
    expect(
      confirmsRetrieval(
        { bestDistance: CHUNK_CONFIRM_DISTANCE.sameScript, keywordHits: 0 },
        { crossScript: false },
      ),
    ).toBe(true);
  });

  it('opens the gate wider for a question in another script than the corpus', () => {
    /* A Chinese question an English corpus answers sits around 0.54. */
    expect(confirmsRetrieval({ bestDistance: 0.55, keywordHits: 1 }, { crossScript: true })).toBe(true);
    expect(confirmsRetrieval({ bestDistance: 0.55, keywordHits: 1 }, { crossScript: false })).toBe(
      false,
    );
    /* Small talk stays out in any script. */
    expect(confirmsRetrieval({ bestDistance: 0.86, keywordHits: 0 }, { crossScript: true })).toBe(false);
  });

  /* Measured on a nine-chunk marketing site, see CHUNK_LOOSE_DISTANCE. */
  it('lets the question itself in a chunk confirm within the loose band', () => {
    const same = { crossScript: false };
    /* "Where is the QR code?": 0.67, "QR code" in three chunks. */
    expect(
      confirmsRetrieval(
        { bestDistance: 0.67, keywordHits: 9, keywordEvidence: { queryTerms: 2, coveredTerms: 2, phrase: true } },
        same,
      ),
    ).toBe(true);
    /* "Can I sign in with my account?": 0.707, both words in one chunk, no phrase. */
    expect(
      confirmsRetrieval(
        { bestDistance: 0.707, keywordHits: 5, keywordEvidence: { queryTerms: 2, coveredTerms: 2, phrase: false } },
        same,
      ),
    ).toBe(true);
    /* "Which plan has view count analytics?": 0.556, "view count" with three of four words. */
    expect(
      confirmsRetrieval(
        { bestDistance: 0.556, keywordHits: 4, keywordEvidence: { queryTerms: 4, coveredTerms: 3, phrase: true } },
        same,
      ),
    ).toBe(true);
  });

  it('keeps ordinary words and partial matches out of the band', () => {
    const same = { crossScript: false };
    /* "How many visits does the Louvre get per month?": 0.671, "visits" and "month" of three. */
    expect(
      confirmsRetrieval(
        { bestDistance: 0.671, keywordHits: 9, keywordEvidence: { queryTerms: 3, coveredTerms: 2, phrase: false } },
        same,
      ),
    ).toBe(false);
    /* "Do you use cookies?": one content word is never evidence, however distinctive. */
    expect(
      confirmsRetrieval(
        { bestDistance: 0.706, keywordHits: 4, keywordEvidence: { queryTerms: 1, coveredTerms: 1, phrase: false } },
        same,
      ),
    ).toBe(false);
    /* "QR code scanner app for Android": the phrase is there, the question is not (0.753). */
    expect(
      confirmsRetrieval(
        { bestDistance: 0.753, keywordHits: 6, keywordEvidence: { queryTerms: 5, coveredTerms: 2, phrase: true } },
        same,
      ),
    ).toBe(false);
    /* Full coverage beyond the band is still too far. */
    expect(
      confirmsRetrieval(
        { bestDistance: CHUNK_LOOSE_DISTANCE + 0.01, keywordHits: 3, keywordEvidence: { queryTerms: 2, coveredTerms: 2, phrase: true } },
        same,
      ),
    ).toBe(false);
    /* A cache entry from before the evidence existed is judged as it was. */
    expect(confirmsRetrieval({ bestDistance: 0.6, keywordHits: 9 }, same)).toBe(false);
    expect(strongKeywordEvidence(null)).toBe(false);
    expect(strongKeywordEvidence({ queryTerms: 3, coveredTerms: 2, phrase: true })).toBe(true);
    expect(strongKeywordEvidence({ queryTerms: 5, coveredTerms: 3, phrase: true })).toBe(false);
  });
});
