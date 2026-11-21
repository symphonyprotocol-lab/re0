/**
 * Post display fixes (2026-11-19, local testing on the real model):
 * - feed and quote excerpts are plain text, not raw Markdown;
 * - a round-table summary's source markers ([A2][A7]) are chips with room
 *   around them, clickable when they carry a citation -- not names run
 *   together as text.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import { plainOf, previewOf } from '@/lib/domain/public-qa';
import type { PostView } from '@/lib/domain/post';

vi.mock('next/navigation', () => ({ usePathname: () => '/p/x', useRouter: () => ({ refresh: () => {}, push: () => {} }), useSearchParams: () => new URLSearchParams() }));

const { PostDetail } = await import('@/components/posts/post-detail');
const { PostCard } = await import('@/components/posts/post-card');

describe('plainOf', () => {
  it('drops Markdown marks from an answer as the feed showed it raw', () => {
    const answer = '设计系统里的按钮组件规范以及需要考虑的状态如下：\n\n1. **基础规范与命名**：\n   设计令牌使用 `color-text-primary` [1]。\n2. *状态*：默认、悬停\n\n## 小结\n- 见 [文档](https://example.com/a_(b)) > 引用';
    expect(plainOf(answer)).toBe('设计系统里的按钮组件规范以及需要考虑的状态如下： 基础规范与命名： 设计令牌使用 color-text-primary [1]。 状态：默认、悬停 小结 见 文档 > 引用');
    expect(plainOf('> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |')).toBe('quoted a b 1 2');
    expect(plainOf('```ts\nconst x = 1;\n```\nsnake_case_name and 2*3*4')).toBe('const x = 1; snake_case_name and 2*3*4');
  });

  it('cuts after stripping, so the excerpt never ends inside a mark', () => {
    const { answer } = previewOf(plainOf(`**${'很长的内容'.repeat(80)}**`), 50);
    expect(answer).not.toContain('*');
    expect(answer.endsWith('…')).toBe(true);
  });
});

const t = messages('zh');
const ree = (id: string, name: string) => ({ id: `ans-${id}`, reeId: id, reeSlug: id, reeName: name, reeAvatar: null, reeColor: 'default', official: false, similarity: 0.8, state: 'answered' as const, text: 'x', truncated: false, citations: [], helpful: 0, voted: false, pinned: false, paid: false, unhelpful: 0, unvoted: false, cost: null });
const citation = { index: 2, title: '组件状态清单', excerpt: '默认、悬停、聚焦、禁用', kind: 'text' } as never;
const post: PostView = {
  id: '00000000-0000-4000-8000-000000000001', visibility: 'public', title: null, pinned: false, archived: false, publishedCopyId: null, question: '按钮组件规范？', detail: '', lang: 'zh', category: null,
  author: { kind: 'user', name: 'Lin', avatar: null, mine: false }, status: 'published', answerState: 'done', answered: 2, candidates: 2, skipped: 0,
  helpful: 0, voted: false, saved: false, createdAt: '2026-11-19T00:00:00.000Z',
  answers: [ree('a', '设计系统顾问'), ree('b', 'APAGE')],
  summary: {
    state: 'done',
    content: '…的实现方式 [A2][A7] vs [B3]。',
    sources: [
      { marker: 'A2', reeId: 'a', messageId: 'm1', index: 2, citation },
      { marker: 'A7', reeId: 'a', messageId: 'm1', index: 7, citation },
      { marker: 'B3', reeId: 'b', messageId: 'm2', index: 3, citation: null },
    ],
  },
  summaryStale: false, summaryRewriteFree: false, hiddenBy: null, quote: null, quotes: 0, paidRequests: [], spent: null, aiAnswer: null, followupCount: 0, followups: [], followupCandidates: [], followupBlocked: null, followupAiOnly: false, deleted: false,
};

describe('a post\'s round-table summary', () => {
  it('shows each source marker as its own chip: a button with a citation, a plain chip without', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: createElement(PostDetail, { initial: post, signedIn: false, now: Date.parse('2026-11-19T01:00:00Z'), loginHref: '/login' }) }));
    expect(html).toMatch(/<button[^>]*class="synthesis-source"[^>]*>设计系统顾问 2<\/button><button[^>]*class="synthesis-source"[^>]*>设计系统顾问 7<\/button>/);
    expect(html).toMatch(/<span class="synthesis-source plain">APAGE 3<\/span>/);
    expect(html).not.toContain('设计系统顾问 2设计系统顾问 7');
  });
});

describe('a post\'s 👍 and 💬 (2026-11-20)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const render = (node: (props: any) => React.ReactNode, props: Record<string, unknown>) => renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: createElement(node as never, props as never) }));

  it('lets a signed-in reader press 有帮助 on the post; a visitor goes to sign in', () => {
    const signedIn = render(PostCard, { post: { ...post, helpful: 3, voted: true }, now: 0, signedIn: true });
    expect(signedIn).toMatch(/<button type="button" class="icon-btn" aria-pressed="true" title="有帮助"[^>]*><svg[^>]*class="text-blue"/);
    const visitor = render(PostCard, { post, now: 0, signedIn: false });
    expect(visitor).toMatch(/<a title="登录后可以标记有帮助" aria-label="有帮助 0" class="workspace-link icon-btn" href="\/login\?returnTo=%2Fp%2F00000000-0000-4000-8000-000000000001">/);
  });

  it('opens the post at its answers from the card, and scrolls to them on the post', () => {
    expect(render(PostCard, { post, now: 0, signedIn: false })).toMatch(/<a title="回答" aria-label="回答 \d+" class="workspace-link icon-btn" href="(\/zh)?\/p\/00000000-0000-4000-8000-000000000001#answers">/);
    const page = render(PostDetail, { initial: post, signedIn: false, now: 0, loginHref: '/login' });
    expect(page).toContain('<a href="#answers" class="icon-btn" title="回答"');
    expect(page).toMatch(/<div class="post-answers-head scroll-mt-24" id="answers">/);
  });
});
