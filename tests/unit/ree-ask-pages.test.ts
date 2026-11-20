/**
 * A Ree's share page and Ree page without chat (design 稿 2, sections 5
 * and 6, 2026-11-20): what people asked is post cards, not bubbles; the
 * page ends with 向 {name} 提问 -- this Ree named, 公开帖子 / 私密提问 -- and
 * a visitor sees the same box with 登录后提问 back to it. No anonymous chat,
 * no 开始对话 / 加入对话, no 回答后公开.
 */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import type { PostView } from '@/lib/domain/post';
import type { PublicRee } from '@/lib/services/public-rees';

vi.mock('next/navigation', () => ({
  usePathname: () => '/s/tax',
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const state = vi.hoisted(() => ({ user: null as { id: string } | null }));
const t = messages('zh');
vi.mock('@/lib/http/session', () => ({ currentUser: async () => state.user }));
vi.mock('@/i18n/server', async () => {
  const { messages: load } = await import('@/i18n');
  return { serverMessages: async () => ({ t: load('zh'), locale: 'zh' }) };
});
vi.mock('@/lib/services/video', () => ({ introsFor: async () => new Map() }));

const ree: PublicRee = {
  id: '00000000-0000-4000-8000-0000000000b1', slug: 'tax', name: '个税顾问', description: '个人所得税和年度汇算。', avatarBlob: null, coverBlob: null, color: 'default',
  category: 'professional', tags: [], sampleQuestions: ['租房扣除每个月能扣多少？'], ownerId: '00000000-0000-4000-8000-0000000000c1', ownerName: '王税务', ownerAvatar: null,
  ownerTitle: '', ownerDescription: '', ownerWebsite: '', ownerSocialContacts: [], role: 'normal', queryFee: 0, takesPosts: true, publicQaEnabled: true, price: 20,
  sources: 3, answers: 5, positiveRate: null, updatedAt: new Date('2026-11-20T00:00:00Z'),
};
const post: PostView = {
  id: '00000000-0000-4000-8000-000000000001', visibility: 'public', title: null, pinned: false, archived: false, publishedCopyId: null, question: '年度汇算什么时候办？', detail: '', lang: 'zh', category: 'professional',
  author: { kind: 'user', name: '周舟', avatar: null, mine: false }, status: 'published', answerState: 'done', answered: 2, candidates: 3, skipped: 0,
  helpful: 3, voted: false, saved: false, createdAt: '2026-11-20T00:00:00.000Z',
  answers: [{ id: '00000000-0000-4000-8000-0000000000a1', reeId: ree.id, reeSlug: 'tax', reeName: '个税顾问', reeAvatar: null, reeColor: 'default', official: false, similarity: 0.8, state: 'answered', text: '每年 3 月 1 日至 6 月 30 日 [1]。', truncated: false, citations: [], helpful: 3, voted: false, pinned: true, paid: false, unhelpful: 0, unvoted: false, cost: null }],
  summary: null, summaryStale: false, summaryRewriteFree: false, hiddenBy: null, quote: null, quotes: 0, paidRequests: [], spent: null, aiAnswer: null, followupCount: 0, followups: [],
  followupCandidates: [], followupBlocked: null, followupAiOnly: false, deleted: false,
};
vi.mock('@/lib/services/public-rees', async (original) => ({ ...(await original<typeof import('@/lib/services/public-rees')>()), publicReeBySlug: async () => ree }));
vi.mock('@/lib/services/posts', async (original) => ({ ...(await original<typeof import('@/lib/services/posts')>()), reePostPicks: async () => ({ items: [post], total: 4 }) }));

const SharePage = (await import('@/app/s/[slug]/page')).default;
const { ReeDetailView } = await import('@/components/discover/ree-detail-view');

const wrap = (element: ReactElement) => renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: element }));
const share = async () => wrap((await SharePage({ params: Promise.resolve({ slug: 'tax' }), searchParams: Promise.resolve({}) })) as ReactElement);
const reePage = (viewerId?: string) =>
  wrap(
    createElement(ReeDetailView, {
      savedRee: ree, query: {}, viewerId, preview: false, from: '/explore', related: null, author: null, video: null,
      comments: { items: [], total: 0, next: null } as never, posts: { items: [post], total: 1, next: null }, renderedAt: Date.parse('2026-11-20T01:00:00Z'),
    }),
  );

/** What both pages must show instead of chat. */
function expectPostsAndBox(html: string) {
  expect(html).toContain('class="post-card"');
  expect(html).toContain('年度汇算什么时候办？');
  expect(html).toContain('每年 3 月 1 日至 6 月 30 日');
  expect(html).not.toContain('ree-qa-item');
  expect(html).not.toContain('rounded-2xl rounded-br-md');
  expect(html).toContain('aria-label="向 个税顾问 提问"');
  expect(html).toMatch(/<span class="fu-chip ask-chip">.*个税顾问<\/span>/);
  expect(html).toContain('role="radiogroup" aria-label="谁能看到"');
  expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>.*?公开帖子/);
  expect(html).toMatch(/role="radio" aria-checked="false"[^>]*>.*?私密提问/);
}

beforeEach(() => {
  state.user = null;
});

describe('the share page', () => {
  it('shows a visitor post cards and the box with 登录后提问 back to it', async () => {
    const html = await share();
    expectPostsAndBox(html);
    expect(html).toContain('4 个公开帖子中的精选');
    expect(html).toContain('查看全部 4 个帖子');
    expect(html).toContain(`href="/login?returnTo=${encodeURIComponent('/s/tax#ask')}"`);
    expect(html).toContain('>登录后提问<span class="workspace-link-progress"');
    expect(html).not.toContain('开始对话');
    expect(html).not.toContain('免登录试聊');
  });

  it('gives a signed-in reader the composer naming the Ree', async () => {
    state.user = { id: '00000000-0000-4000-8000-0000000000d1' };
    const html = await share();
    expectPostsAndBox(html);
    expect(html).not.toContain('登录后提问');
    expect(html).toContain('placeholder="向 个税顾问 提问…"');
    expect(html).toContain('>发布</button>');
  });
});

describe('the Ree page', () => {
  it('lists answered posts as cards under the box, and the rail goes to the box', () => {
    const html = reePage('00000000-0000-4000-8000-0000000000d1');
    expectPostsAndBox(html);
    expect(html).toContain(`</svg>${t.posts.ask.jump}</button>`);
    expect(html).not.toContain('加入对话');
  });

  it('shows a visitor the same box with 登录后提问', () => {
    const html = reePage();
    expectPostsAndBox(html);
    expect(html).toContain(`href="/login?returnTo=${encodeURIComponent('/r/tax#ask')}"`);
    expect(html).toContain('>登录后提问<span class="workspace-link-progress"');
  });

  it('gives the owner 置顶 and 隐藏 on its answer', () => {
    const html = reePage(ree.ownerId);
    expect(html).toContain('class="ree-post-owner"');
    expect(html).toContain('取消置顶');
  });
});

describe('一起问前 3 个 Ree', () => {
  it('opens the composer\'s 私密提问 with the Rees chosen and the question written', async () => {
    const { RoundtableEntry, roundtableHref } = await import('@/components/discover/roundtable-entry');
    const rees = [{ id: 'a1', name: 'A', price: 20, avatarBlob: null, color: 'default' }, { id: 'b2', name: 'B', price: 50, avatarBlob: null, color: 'default' }];
    const href = roundtableHref('租房扣除？', ['a1', 'b2']);
    expect(href).toBe(`/?compose=private&rees=a1%2Cb2&ask=${encodeURIComponent('租房扣除？')}`);
    /* WorkspaceLink puts the language in front: /zh?compose=… */
    expect(wrap(createElement(RoundtableEntry, { question: '租房扣除？', rees, signedIn: true }))).toContain(`href="/zh${href.slice(1).replace(/&/g, '&amp;')}"`);
    expect(wrap(createElement(RoundtableEntry, { question: '租房扣除？', rees, signedIn: false }))).toContain(`href="/login?returnTo=${encodeURIComponent(href)}"`);
  });
});

describe('试问', () => {
  it('shows each try as a question with its answer card, not a chat', async () => {
    const { ReeTry } = await import('@/components/rees/ree-try');
    const tried: PostView = { ...post, visibility: 'private', author: { kind: 'user', name: '王税务', avatar: null, mine: true }, answers: [{ ...post.answers[0]!, cost: 20 }] };
    const html = wrap(createElement(ReeTry, { ree: { id: ree.id, name: ree.name, avatarBlob: null, color: 'default', sampleQuestions: ree.sampleQuestions }, readiness: { ready: 3, processing: 0 }, initial: [tried] }));
    expect(html).toContain('试问 个税顾问');
    expect(html).toContain('class="post-card ree-try-item"');
    expect(html).toContain('class="post-answer"');
    expect(html).toContain('<span class="answer-cost">20 credits</span>');
    expect(html).toContain(`href="/zh/p/${post.id}"`);
    expect(html).not.toContain('rounded-br-md');
    expect(html).not.toContain('message-head');
  });
});
