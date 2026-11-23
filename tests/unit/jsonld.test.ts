import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPrice } from '@/lib/domain/pricing';
import type { PostAnswerView, PostView } from '@/lib/domain/post';
import { exploreJsonLd, postJsonLd, pricingJsonLd } from '@/lib/jsonld';

beforeEach(() => vi.stubEnv('APP_BASE_URL', 'https://re0.io/'));
afterEach(() => vi.unstubAllEnvs());

describe('pricingJsonLd', () => {
  it('describes a web application, not a product, priced in USD from the catalogue', () => {
    const data = pricingJsonLd({ plan: defaultPrice('plan'), pack: defaultPrice('pack') }, 'en', 'd');
    expect(data).toMatchObject({ '@type': 'WebApplication', name: 'RE0', url: 'https://re0.io/en/pricing', image: 'https://re0.io/og/site/en', applicationCategory: 'ReferenceApplication', operatingSystem: 'Web' });
    const offers = data.offers as Record<string, unknown>[];
    expect(offers.map((offer) => [offer.name, offer.price, offer.priceCurrency])).toEqual([
      ['Free', '0', 'USD'],
      [expect.stringMatching(/^Plan/), (defaultPrice('plan').priceMinor / 100).toFixed(2), 'USD'],
      [expect.stringMatching(/^Pack/), (defaultPrice('pack').priceMinor / 100).toFixed(2), 'USD'],
    ]);
    expect(JSON.stringify(data)).not.toMatch(/"Product"|aggregateRating|review|shipping|ReturnPolicy/);
  });
});

const answer = (id: string, overrides: Partial<PostAnswerView> = {}) =>
  ({ id, reeSlug: `ree-${id}`, reeName: `Ree ${id}`, state: 'answered', text: `Answer ${id}`, helpful: 2, pinned: false, ...overrides }) as PostAnswerView;

const post = (overrides: Partial<PostView> = {}) =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    visibility: 'public',
    status: 'published',
    hiddenBy: null,
    deleted: false,
    question: 'How do I reset it?',
    detail: '',
    lang: 'en',
    author: { kind: 'user', name: 'Ann', avatar: null, mine: false },
    createdAt: '2026-11-20T10:00:00.000Z',
    answers: [answer('a'), answer('b', { pinned: true }), answer('c', { state: 'no_answer', text: '' })],
    ...overrides,
  }) as PostView;

describe('postJsonLd', () => {
  it('is a Q&A page: the pinned answer accepted, the others suggested, each at its anchor', () => {
    const data = postJsonLd(post({ detail: ' It beeps. ' }), 'zh')!;
    expect(data).toMatchObject({ '@type': 'QAPage', '@id': 'https://re0.io/zh/p/00000000-0000-4000-8000-000000000001', inLanguage: 'zh-CN' });
    const question = data.mainEntity as Record<string, unknown>;
    expect(question).toMatchObject({ '@type': 'Question', inLanguage: 'en', name: 'How do I reset it?', text: 'How do I reset it?\n\nIt beeps.', answerCount: 2, datePublished: '2026-11-20T10:00:00.000Z', author: { '@type': 'Person', name: 'Ann' } });
    expect(question.acceptedAnswer).toEqual([{ '@type': 'Answer', text: 'Answer b', url: 'https://re0.io/zh/p/00000000-0000-4000-8000-000000000001#a-b', upvoteCount: 2 }]);
    expect((question.suggestedAnswer as { text: string }[]).map((entry) => entry.text)).toEqual(['Answer a']);
  });

  it('names no asker the page hides, and leaves out an empty accepted list', () => {
    const question = postJsonLd(post({ author: { kind: 'hidden', mine: false }, answers: [answer('a')] }), 'en')!.mainEntity as Record<string, unknown>;
    expect(question.author).toBeUndefined();
    expect(question.acceptedAnswer).toBeUndefined();
    expect(JSON.parse(JSON.stringify(question))).not.toHaveProperty('acceptedAnswer');
  });

  it('is left out of a page that is not indexed', () => {
    expect(postJsonLd(post({ visibility: 'private' }), 'en')).toBeNull();
    expect(postJsonLd(post({ status: 'pending' }), 'en')).toBeNull();
    expect(postJsonLd(post({ hiddenBy: 'admin' }), 'en')).toBeNull();
    expect(postJsonLd(post({ deleted: true }), 'en')).toBeNull();
    expect(postJsonLd(post({ answers: [answer('c', { state: 'answering', text: '' })] }), 'en')).toBeNull();
  });
});

describe('exploreJsonLd', () => {
  it('lists the Rees in order at their own pages', () => {
    const data = exploreJsonLd([{ slug: 'dw200', name: 'DW200' }, { slug: 'tax', name: 'Tax' }], 'en', { name: 'Rees', description: 'd' });
    expect(data).toMatchObject({ '@type': 'CollectionPage', url: 'https://re0.io/en/explore', name: 'Rees', isPartOf: { '@id': 'https://re0.io/#website' } });
    expect(data.mainEntity).toEqual({
      '@type': 'ItemList',
      numberOfItems: 2,
      itemListElement: [
        { '@type': 'ListItem', position: 1, url: 'https://re0.io/en/r/dw200', name: 'DW200' },
        { '@type': 'ListItem', position: 2, url: 'https://re0.io/en/r/tax', name: 'Tax' },
      ],
    });
  });
});
