/**
 * "我也问一句" on a Ree page's public answers (#161 review, 2026-11-19):
 * visitors no longer ask there, so for them it is a sign-in link that comes
 * back to the page's question box; a signed-in reader gets the button that
 * fills the box.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import type { PublicQaPage } from '@/lib/domain/public-qa';

vi.mock('next/navigation', () => ({ usePathname: () => '/r/x', useRouter: () => ({ refresh: () => {}, push: () => {} }), useSearchParams: () => new URLSearchParams() }));

const { PublicQaList } = await import('@/components/discover/public-qa');

const ree = { id: '00000000-0000-4000-8000-000000000001', slug: 'x', name: 'X', avatarBlob: null, color: 'default' };
const initial: PublicQaPage = {
  items: [{ id: '00000000-0000-4000-8000-000000000002', postId: '00000000-0000-4000-8000-000000000003', asker: 'user', author: null, question: 'How long do refunds take?', answer: 'Within 14 days.', truncated: false, citations: [], helpful: 0, voted: false, pinned: false, publishedAt: '2026-11-19T00:00:00.000Z' }],
  total: 1,
  next: null,
};
const t = messages('zh');
const render = (signedIn: boolean) =>
  renderToStaticMarkup(
    createElement(I18nProvider, {
      locale: 'zh',
      t,
      children: createElement(PublicQaList, { ree, initial, signedIn, owner: false, loginHref: '/login?next=%2Fr%2Fx', followUpLoginHref: '/login?next=%2Fr%2Fx%23ask', renderedAt: Date.parse('2026-11-19T01:00:00Z'), onFollowUp: () => {} }),
    }),
  );

describe('我也问一句', () => {
  it('is a sign-in link back to the question box for a visitor', () => {
    const html = render(false);
    const follow = html.match(/<a[^>]*ree-qa-follow[^>]*>/)?.[0] ?? '';
    expect(follow).toContain('href="/login?next=%2Fr%2Fx%23ask"');
    expect(follow).toContain(`title="${t.discover.public.qa.followUpSignIn}"`);
    expect(html).not.toMatch(/<button[^>]*ree-qa-follow/);
  });

  it('is a button that fills the box for a signed-in reader', () => {
    const html = render(true);
    expect(html).toMatch(/<button[^>]*ree-qa-follow/);
    expect(html).not.toMatch(/<a[^>]*ree-qa-follow/);
  });
});
