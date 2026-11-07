import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthorProfile } from '@/components/discover/author-profile';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import { profileWebUrl } from '@/lib/domain/account';

const author = { name: 'Creator', avatar: null, role: 'normal', title: '', description: '', website: '', socialContacts: [] };
const render = (details: Partial<Parameters<typeof AuthorProfile>[0]['author']>, locale: 'zh' | 'en' = 'zh') => renderToStaticMarkup(createElement(I18nProvider, { locale, t: messages(locale), children: createElement(AuthorProfile, { author: { ...author, ...details } }) }));

describe('public author profile', () => {
  it('shows filled profile fields with safe links and copy controls for plain handles', () => {
    const html = render({ title: 'Designer', description: 'First line\nSecond line', website: 'https://example.com', socialContacts: [{ platform: 'GitHub', value: 'https://github.com/creator' }, { platform: '微信', value: 'creator-id' }] });
    for (const text of ['关于作者', 'Creator', 'Designer', 'First line\nSecond line', 'href="https://example.com"', 'href="https://github.com/creator"', 'creator-id', 'aria-label="复制 微信 账号"', 'rel="noopener noreferrer nofollow ugc"', 'href="#author-contact"', 'id="author-contact"', '查看联系方式']) expect(html).toContain(text);
    expect(html).not.toContain('href="creator-id"');
  });

  it('hides absent optional details and supports English visitors', () => {
    const html = render({}, 'en');
    expect(html).toContain('About the creator');
    expect(html).toContain('Creator');
    expect(html).not.toContain('Website');
    expect(html).not.toContain('Social media &amp; contact');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<button ');
  });

  it('renders unsafe and non-web contact values as escaped text instead of links', () => {
    const html = render({ website: 'javascript:alert(1)', description: '<script>alert(1)</script>', socialContacts: [{ platform: 'Custom', value: 'javascript:alert(1)' }] });
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    for (const value of ['@creator', 'javascript:alert(1)', 'data:text/html,test', '//example.com', 'https://user:pw@example.com', 'https://']) expect(profileWebUrl(value)).toBeNull();
    expect(profileWebUrl(' https://example.com/path ')).toBe('https://example.com/path');
  });
});
