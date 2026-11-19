/**
 * The Ree page's and share page's question boxes follow the owner's public
 * Q&A switch (review 2026-11-18, #158 item 4): with it off there is no
 * "回答后公开" to tick, only a note saying answers stay private.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';

vi.mock('next/navigation', () => ({ usePathname: () => '/r/x', useRouter: () => ({ refresh: () => {}, push: () => {} }), useSearchParams: () => new URLSearchParams() }));

const { AnonymousChat } = await import('@/components/discover/anonymous-chat');
const { SignedInAsk } = await import('@/components/discover/signed-in-ask');

const ree = { id: '00000000-0000-4000-8000-000000000001', slug: 'x', name: 'X', avatarBlob: null, color: 'default', sampleQuestions: [] };
const t = messages('zh');
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: element }));

describe('public Q&A switched off', () => {
  it('never offers a visitor 回答后公开: their answers stay in their tab (2026-11-19)', () => {
    const html = render(createElement(AnonymousChat, { ree, loginHref: '/login', shareToken: 'token', shareSlug: 'x' }));
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain(t.discover.public.anonymous.onlyYou);
  });

  it('offers it to a signed-in asker only while it is on', () => {
    const props = { ree, price: 20, queryFee: 0, sampleQuestions: [] };
    expect(render(createElement(SignedInAsk, props))).toContain('type="checkbox"');
    const off = render(createElement(SignedInAsk, { ...props, canPublish: false }));
    expect(off).not.toContain('type="checkbox"');
    expect(off).toContain(t.discover.public.qa.closedNote);
  });
});
