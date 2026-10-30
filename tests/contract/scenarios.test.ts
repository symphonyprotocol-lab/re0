/**
 * The four scenario pages (agent-first-proposal.md 2.2, 4.2): each renders
 * in zh and in en with its assets, what the Agent does, its outlets and a
 * static demo conversation; Creators' button opens a channel; Life is
 * marked as not promoted; all four are in the sitemap, Life at the bottom.
 * The dictionaries mirror each other's shape.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { messagesFor } from '@/lib/i18n/dictionary';
import type { Locale } from '@/lib/i18n/locale';
import { isPromoted, SCENARIOS } from '@/lib/domain/scenarios';
import { isReservedName } from '@/lib/domain/reserved-names';

const locale = { current: 'zh' as Locale };

vi.mock('@/lib/i18n/server', () => ({
  getMessages: async () => messagesFor(locale.current),
  translations: async () => ({ locale: locale.current, t: messagesFor(locale.current) }),
  currentLocale: async () => locale.current,
}));
vi.mock('@/lib/application/channels', () => ({ publicCardSubjects: async () => ({ channels: [], handles: [] }) }));
vi.mock('@/lib/application/libraries', () => ({ listPublicLibraryLocations: async () => [] }));

const { default: ScenarioPage } = await import('@/app/(public)/for/[scenario]/page');
const { default: sitemap } = await import('@/app/sitemap');

async function render(scenario: string, lang: Locale): Promise<string> {
  locale.current = lang;
  const element = await ScenarioPage({ params: Promise.resolve({ scenario }) });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

describe('the scenario pages', () => {
  for (const lang of ['zh', 'en'] as const) {
    for (const scenario of SCENARIOS) {
      it(`/for/${scenario} renders in ${lang} with its assets, agent, outlets and a static demo`, async () => {
        const html = await render(scenario, lang);
        const words = messagesFor(lang).scenarios;
        const page = words[scenario];
        const text = (value: string) => renderToStaticMarkup(createElement('span', null, value)).slice(6, -7);
        expect(html).toContain(text(page.title));
        for (const item of [...page.assets, ...page.agent, ...page.outlets]) expect(html).toContain(text(item));
        for (const turn of page.demo) expect(html).toContain(text(turn.text));
        expect(html).toContain(text(words.demoNote));
        expect(html).toContain(`href="${page.ctaHref}"`);
        expect(html.includes(text(words.notPromoted))).toBe(!isPromoted(scenario));
      });
    }
  }

  it('gives Creators the open-a-channel button', () => {
    expect(messagesFor('zh').scenarios.creators.cta).toBe('开通频道');
    expect(messagesFor('zh').scenarios.creators.ctaHref).toBe('/dashboard/channels');
  });

  it('keeps every other path a 404 and `for` out of handles and asset owners', async () => {
    await expect(ScenarioPage({ params: Promise.resolve({ scenario: 'pets' }) })).rejects.toThrow();
    expect(isReservedName('for')).toBe(true);
  });

  it('lists all four in the sitemap, Life with the lowest priority', async () => {
    const entries = await sitemap();
    const byPath = new Map(entries.map((entry) => [new URL(entry.url).pathname, entry]));
    for (const scenario of SCENARIOS) expect(byPath.has(`/for/${scenario}`)).toBe(true);
    const life = byPath.get('/for/life')!.priority!;
    expect(life).toBeLessThan(byPath.get('/for/work')!.priority!);
    expect(Math.min(...entries.map((entry) => entry.priority ?? 1))).toBe(life);
  });
});

describe('the dictionaries', () => {
  it('give en the same shape as zh', () => {
    const shape = (value: unknown): unknown =>
      Array.isArray(value)
        ? 'array'
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shape(entry)]).sort(([a], [b]) => String(a).localeCompare(String(b))))
          : typeof value;
    expect(shape(messagesFor('en').scenarios)).toEqual(shape(messagesFor('zh').scenarios));
    expect(shape(messagesFor('en').dashboard.externalAgents)).toEqual(shape(messagesFor('zh').dashboard.externalAgents));
    expect(shape(messagesFor('en').dashboard.delegation)).toEqual(shape(messagesFor('zh').dashboard.delegation));
    expect(shape(messagesFor('en').dashboard.privacyData)).toEqual(shape(messagesFor('zh').dashboard.privacyData));
  });
});
