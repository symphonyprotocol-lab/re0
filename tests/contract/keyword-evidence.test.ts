import { describe, expect, it } from 'vitest';
import { keywordEvidenceOf } from '@/lib/domain/keyword-evidence';

const PRICING =
  'Solo: 400 share links, 20,000 monthly visits, QR codes, and analytics. $3/month. Custom share link. View count analytics. Subscribe';
const PRIVACY = 'We use cookies to keep you signed in to your account. Delete your account at any time.';

describe('keyword evidence', () => {
  it('counts the content words one chunk covers, and sees a phrase', () => {
    expect(keywordEvidenceOf('Where is the QR code?', [PRIVACY, PRICING])).toEqual({
      queryTerms: 2,
      coveredTerms: 2,
      phrase: true,
    });
    /* "links" meets "link", and the phrase survives the plural. */
    expect(keywordEvidenceOf('Can I customize my share link?', [PRICING])).toMatchObject({
      coveredTerms: 2,
      phrase: true,
    });
  });

  it('takes the best chunk, not the sum of them', () => {
    const evidence = keywordEvidenceOf('How do I delete my account?', [PRICING, PRIVACY]);
    expect(evidence).toEqual({ queryTerms: 2, coveredTerms: 2, phrase: false });
    /* Words scattered over chunks do not add up. */
    expect(keywordEvidenceOf('share cookies', [PRICING, PRIVACY])).toMatchObject({ coveredTerms: 1 });
  });

  it('is not fooled by a phrase that is not the question', () => {
    expect(keywordEvidenceOf('QR code scanner app for Android', [PRICING])).toMatchObject({
      queryTerms: 5,
      coveredTerms: 2,
      phrase: true,
    });
  });

  it('has nothing to say about stopwords alone, and no phrase for Han text', () => {
    expect(keywordEvidenceOf('how do I the', [PRICING])).toBeNull();
    const han = keywordEvidenceOf('二维码在哪里', ['二维码在定价页。']);
    expect(han?.phrase).toBe(false);
    expect(han!.coveredTerms).toBeGreaterThan(0);
  });
});
