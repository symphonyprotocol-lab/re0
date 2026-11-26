/**
 * The @Ree chip in the public composers takes its mention off with a × on
 * its corner (2026-11-25): the Ree page and share page boxes, the post
 * window (发帖问它, a quoted answer). Without it the post goes out naming no
 * Ree. A signed-out visitor's box stays that Ree's: nothing to remove there.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import type { Locale } from '@/i18n/locale';
import type { PrivateReeOption } from '@/lib/domain/post';

vi.mock('next/navigation', () => ({ usePathname: () => '/r/dw200', useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));

const { PublicPostForm, publicPostBody } = await import('@/components/posts/composer');
const { ReeAsk } = await import('@/components/posts/ree-ask');

const ree = { id: '00000000-0000-4000-8000-0000000000b1', slug: 'dw200', name: 'DW200 Device Manual' };
const option: PrivateReeOption = { reeId: ree.id, reeSlug: ree.slug, reeName: ree.name, reeAvatar: null, reeColor: 'default', price: 20, paid: false, similarity: null };
const render = (locale: Locale, node: ReactNode) => renderToStaticMarkup(createElement(I18nProvider, { locale, t: messages(locale), children: node }));

describe('the @Ree chip', () => {
  it('has a × that names what it removes, in both languages', () => {
    const zh = render('zh', createElement(PublicPostForm, { mention: { id: ree.id, name: ree.name } }));
    expect(zh).toContain('class="fu-chip ask-chip mention-chip"');
    expect(zh).toContain('class="mention-remove" aria-label="移除 @DW200 Device Manual"');
    const en = render('en', createElement(PublicPostForm, { mention: { id: ree.id, name: ree.name } }));
    expect(en).toContain('aria-label="Remove mention of DW200 Device Manual"');
    /* No mention, no chip. */
    expect(render('en', createElement(PublicPostForm, {}))).not.toContain('mention-chip');
  });

  it('can be removed on a Ree page, signed in; a signed-out visitor\'s box keeps its Ree', () => {
    const props = { ree, option, takesPosts: true, loginHref: '/login', share: null };
    expect(render('en', createElement(ReeAsk, { ...props, signedIn: true }))).toContain('class="mention-remove"');
    const visitor = render('en', createElement(ReeAsk, { ...props, signedIn: false }));
    expect(visitor).toContain('DW200 Device Manual');
    expect(visitor).not.toContain('mention-remove');
  });

  it('once removed, the post goes out naming no Ree', () => {
    const form = { question: 'How do I reset it?', detail: '', anonymous: false, quote: null, clientToken: 't', images: [] };
    expect(publicPostBody({ ...form, mention: { id: ree.id, name: ree.name } }).mentionReeId).toBe(ree.id);
    expect(publicPostBody({ ...form, mention: null })).toEqual({ question: 'How do I reset it?', detail: '', anonymous: false, mentionReeId: null, quotePostId: null, quoteAnswerId: null, clientToken: 't', images: [] });
  });
});
