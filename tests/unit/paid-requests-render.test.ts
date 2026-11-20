/**
 * The post page's paid requests (2026-11-19): the author sees each paid Ree
 * waiting with its creator, match and price, and agree / no thanks; the
 * answer it gives is marked as paid. Nobody else is sent any request.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import { fill } from '@/i18n/format';
import type { PostView } from '@/lib/domain/post';

vi.mock('next/navigation', () => ({ usePathname: () => '/p/x', useRouter: () => ({ refresh: () => {}, push: () => {} }), useSearchParams: () => new URLSearchParams() }));

const { PostDetail } = await import('@/components/posts/post-detail');

const t = messages('zh');
const p = t.posts.page;
const base: PostView = {
  id: '00000000-0000-4000-8000-000000000001', visibility: 'public', title: null, pinned: false, archived: false, publishedCopyId: null, question: 'How long do refunds take?', detail: '', lang: 'en', category: null,
  author: { kind: 'user', name: 'Lin', avatar: null, mine: true }, status: 'published', answerState: 'done', answered: 1, candidates: 3, skipped: 0,
  helpful: 0, voted: false, saved: false, createdAt: '2026-11-19T00:00:00.000Z',
  answers: [{ id: 'a1', reeId: 'r1', reeSlug: 'paid', reeName: 'Paid desk', reeAvatar: null, reeColor: 'default', official: false, similarity: 0.8, state: 'answered', text: 'Within 14 days.', truncated: false, citations: [], helpful: 0, voted: false, pinned: false, paid: true, unhelpful: 0, unvoted: false, cost: null }],
  summary: null, summaryStale: false, summaryRewriteFree: false, hiddenBy: null, quote: null, quotes: 0, followUps: [],
  paidRequests: [{ id: 'q1', reeId: 'r2', reeSlug: 'tax', reeName: 'Tax desk', reeAvatar: null, reeColor: 'default', ownerName: 'Mei', similarity: 0.71, mentioned: false, price: 70, state: 'awaiting' }],
  spent: 20,
  followupCount: 0,
  followups: [],
  followupCandidates: [],
  followupBlocked: null,
  deleted: false,
};
const render = (post: PostView) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: createElement(PostDetail, { initial: post, signedIn: true, now: Date.parse('2026-11-19T01:00:00Z'), loginHref: '/login' }) }));

describe('paid requests on the post page', () => {
  it('shows the author each waiting paid Ree with its creator, price and both choices', () => {
    const html = render(base);
    expect(html).toContain(p.paidTitle);
    expect(html).toContain('Tax desk');
    expect(html).toContain(fill(p.paidBy, { owner: 'Mei' }));
    expect(html).toContain(fill(p.paidAgree, { n: '70' }));
    expect(html).toContain(p.paidDecline);
    /* The answer agreed to earlier is marked as paid. */
    expect(html).toContain(p.paidTag);
  });

  it('shows the answer under way once agreed, without the choices', () => {
    const html = render({ ...base, paidRequests: [{ ...base.paidRequests[0]!, state: 'answering' }] });
    expect(html).toContain(p.paidAnswering);
    expect(html).not.toContain(`>${p.paidDecline}</button>`);
  });

  it('says a refunded answer could not be given and offers to agree again (#164 review)', () => {
    const html = render({ ...base, paidRequests: [{ ...base.paidRequests[0]!, state: 'refunded' }] });
    expect(html).toContain(p.paidRefunded);
    expect(html).toContain(fill(p.paidAgain, { n: '70' }));
    expect(html).toContain(`>${p.paidDecline}</button>`);
  });

  it('offers no further try once a Ree found no answer, or failed on its last try (#164 review 2)', () => {
    for (const [state, line] of [['no_answer', p.paidNoAnswer], ['exhausted', p.paidExhausted]] as const) {
      const html = render({ ...base, paidRequests: [{ ...base.paidRequests[0]!, state }] });
      expect(html).toContain(line);
      expect(html).not.toContain(fill(p.paidAgain, { n: '70' }));
      expect(html).not.toContain(fill(p.paidAgree, { n: '70' }));
      expect(html).toContain(`>${p.paidDecline}</button>`);
    }
  });

  it('shows no request section when there is none (anyone but the author)', () => {
    const html = render({ ...base, author: { kind: 'user', name: 'Lin', avatar: null, mine: false }, paidRequests: [] });
    expect(html).not.toContain(p.paidTitle);
  });
});
