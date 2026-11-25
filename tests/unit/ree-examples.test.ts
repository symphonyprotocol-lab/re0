/**
 * A public Ree page's answered questions (GSC review 2026-11, 6.8, B8): the
 * answer's opening as the page shows it, the meta description built from
 * the first one, and the section itself -- server HTML with the questions
 * as h3s, citation markers and a plain link to each post.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { answerSummary, META_DESCRIPTION_CHARS, reeExampleDescription, REE_EXAMPLE_SUMMARY_CHARS, sentencesOf, withoutMarkers, type ReeExample } from '@/lib/domain/ree-examples';
import { reeMetaDescription } from '@/lib/seo';
import { ReeExamples } from '@/components/discover/ree-examples';
import { messages } from '@/i18n';

const length = (text: string) => Array.from(text).length;

describe('answerSummary', () => {
  it('keeps the first three sentences with their citation markers, as plain text', () => {
    const text = '## Short answer\n\nUse **`Runtime::shutdown_timeout`** to stop it [1]. Tasks are cancelled at the next `.await` [2]. Blocking work keeps running [1][2]. A fourth sentence is left out.';
    expect(answerSummary(text)).toBe('Short answer Use Runtime::shutdown_timeout to stop it [1]. Tasks are cancelled at the next .await [2]. Blocking work keeps running [1][2].');
  });

  it('does not split a number, and splits Chinese on its own stops', () => {
    expect(sentencesOf('Version 3.5 ships it [1]. Then 4.0 drops it.')).toEqual(['Version 3.5 ships it [1].', 'Then 4.0 drops it.']);
    expect(answerSummary('每年 3 月 1 日至 6 月 30 日办理 [1]。可以在个税 App 里办 [2]。也可以委托单位。还可以去税务大厅。')).toBe('每年 3 月 1 日至 6 月 30 日办理 [1]。可以在个税 App 里办 [2]。也可以委托单位。');
  });

  it('stops before the length limit, and cuts a long first sentence on a word', () => {
    const long = `${'word '.repeat(120)}end [1].`;
    const summary = answerSummary(`${long} Second.`);
    expect(summary.length).toBeLessThanOrEqual(REE_EXAMPLE_SUMMARY_CHARS + 1);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary).not.toContain('Second.');
    expect(answerSummary(`First [1]. ${'x'.repeat(400)}.`)).toBe('First [1].');
  });

  it('drops the unfinished sentence at the end of a cut read', () => {
    expect(answerSummary('One [1]. Two [2]. Thr', true)).toBe('One [1]. Two [2].');
    expect(answerSummary('Only one unfinished', true)).toBe('Only one unfinished');
    expect(answerSummary('')).toBe('');
  });
});

describe('the meta description', () => {
  const coverage = 'Answers questions on Tokio: the runtime, tasks, channels, timers and graceful shutdown, from the official Tokio documentation and tutorial.';

  it('opens with the first question and its answer, then the coverage, at about 155 characters and without markers', () => {
    const description = reeExampleDescription({ question: 'How do I shut down a Tokio runtime', summary: 'Drop the runtime or call shutdown_timeout [1]. Tasks stop at their next await [2].' }, coverage);
    expect(description.startsWith('How do I shut down a Tokio runtime? Drop the runtime or call shutdown_timeout.')).toBe(true);
    expect(description).toContain('Answers questions on Tokio');
    expect(description).not.toMatch(/\[\d/);
    expect(length(description)).toBeLessThanOrEqual(META_DESCRIPTION_CHARS);
    expect(length(description)).toBeGreaterThan(140);
  });

  it('keeps a long question to half and a long answer short, so the coverage still has room', () => {
    const question = `What is ${'the very long part of a question '.repeat(6)}`;
    const description = reeExampleDescription({ question, summary: `${'An equally long answer sentence goes on '.repeat(6)}[1].` }, coverage);
    expect(length(description)).toBeLessThanOrEqual(META_DESCRIPTION_CHARS);
    expect(description.indexOf('…')).toBeLessThanOrEqual(META_DESCRIPTION_CHARS / 2);
    expect(description).toContain('An equally long');
    expect(description).toContain('Answers questions on Tokio');
  });

  it('gives the answer the coverage\'s room when there is no coverage', () => {
    const summary = 'Call revalidatePath (or revalidateTag) inside the Server Action after the write succeeds, then redirect if you need to [1].';
    const description = reeExampleDescription({ question: 'How do I revalidate a page right after a Server Action saves a form?', summary }, '');
    expect(length(description)).toBeLessThanOrEqual(META_DESCRIPTION_CHARS);
    expect(length(description)).toBeGreaterThan(140);
    expect(description).toMatch(/^How do I revalidate .*\? Call revalidatePath .*…$/);
  });

  it('reads in Chinese too', () => {
    const description = reeExampleDescription({ question: '年度汇算什么时候办', summary: '每年 3 月 1 日至 6 月 30 日 [1]。' }, '个人所得税和年度汇算。');
    expect(description).toBe('年度汇算什么时候办？每年 3 月 1 日至 6 月 30 日。个人所得税和年度汇算。');
  });

  it('is the Ree\'s own description when nothing is answered, else the site\'s sentence', () => {
    expect(reeMetaDescription({ description: coverage }, [], 'A Ree on RE0.')).toBe(coverage);
    expect(reeMetaDescription({ description: '' }, [], 'A Ree on RE0.')).toBe('A Ree on RE0.');
    expect(reeMetaDescription({ description: coverage }, [{ question: 'Is it async?', summary: 'Yes [1].' }], 'A Ree on RE0.')).toMatch(/^Is it async\? Yes\. Answers questions on Tokio/);
    expect(withoutMarkers('Yes [1][2], it is [3, 4].')).toBe('Yes, it is.');
  });
});

describe('the Answered questions section', () => {
  const examples: ReeExample[] = [
    { postId: '00000000-0000-4000-8000-000000000001', question: 'How do I shut down a Tokio runtime?', lang: 'en', summary: 'Drop it or call shutdown_timeout [1]. Tasks stop at the next await [2].', sources: [{ index: 1, title: 'Runtime' }, { index: 2, title: 'Cancellation' }, { index: 3, title: 'Unused' }] },
    { postId: '00000000-0000-4000-8000-000000000002', question: '年度汇算什么时候办？', lang: 'zh', summary: '每年 3 月 1 日至 6 月 30 日。', sources: [] },
  ];
  const render = (locale: 'en' | 'zh', list = examples) => renderToStaticMarkup(createElement(ReeExamples, { examples: list, locale, labels: messages(locale).discover.public.examples }));

  it('renders each question as an h3 under one h2, its answer with markers, and a plain link to the post', () => {
    const html = render('en');
    expect(html.match(/<h2\b/g)).toHaveLength(1);
    expect(html).toContain('>Answered questions</h2>');
    expect(html).not.toContain('<h1');
    expect(html.match(/<h3\b/g)).toHaveLength(2);
    expect(html).toContain('>How do I shut down a Tokio runtime?</h3>');
    expect(html).toContain('<sup class="ml-0.5 font-mono text-[10px] text-blue" title="Runtime">[1]</sup>');
    expect(html).toContain('Sources: ');
    expect(html).toContain('Cancellation');
    expect(html).not.toContain('Unused');
    expect(html).toContain('href="/en/p/00000000-0000-4000-8000-000000000001"');
    expect(html).toContain('href="/en/p/00000000-0000-4000-8000-000000000002"');
    expect(html).not.toMatch(/href="[^"]*\?/);
    expect(html).toContain('lang="zh-CN"');
  });

  it('speaks the page\'s language and links in it', () => {
    const html = render('zh');
    expect(html).toContain('>已回答的问题</h2>');
    expect(html).toContain('href="/zh/p/00000000-0000-4000-8000-000000000001"');
  });

  it('is left out when nothing is answered', () => {
    expect(render('en', [])).toBe('');
  });
});
