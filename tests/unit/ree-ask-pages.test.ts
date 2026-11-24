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

const state = vi.hoisted(() => ({ user: null as { id: string } | null, sparse: false, visitorAsks: false }));
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
  ownerTitle: '', ownerDescription: '', ownerWebsite: '', ownerSocialContacts: [], role: 'normal', queryFee: 0, takesPosts: true, publicQaEnabled: true, visitorAsks: false, price: 20,
  sources: 3, answers: 5, positiveRate: null, updatedAt: new Date('2026-11-20T00:00:00Z'),
};
const post: PostView = {
  id: '00000000-0000-4000-8000-000000000001', visibility: 'public', title: null, pinned: false, archived: false, publishedCopyId: null, question: '年度汇算什么时候办？', detail: '', lang: 'zh', category: 'professional',
  author: { kind: 'user', name: '周舟', avatar: null, mine: false }, status: 'published', answerState: 'done', answered: 2, candidates: 3, skipped: 0,
  helpful: 3, voted: false, saved: false, createdAt: '2026-11-20T00:00:00.000Z',
  answers: [{ id: '00000000-0000-4000-8000-0000000000a1', reeId: ree.id, reeSlug: 'tax', reeName: '个税顾问', reeAvatar: null, reeColor: 'default', official: false, similarity: 0.8, state: 'answered', text: '每年 3 月 1 日至 6 月 30 日 [1]。', truncated: false, citations: [], helpful: 3, voted: false, pinned: true, paid: false, unhelpful: 0, unvoted: false, cost: null }],
  summary: null, summaryStale: false, summaryRewriteFree: false, hiddenBy: null, quote: null, quotes: 0, images: [], channels: [], paidRequests: [], spent: null, aiAnswer: null, followupCount: 0, followups: [],
  followupCandidates: [], followupBlocked: null, followupAiOnly: false, deleted: false,
};
const second: PostView = {
  ...post, id: '00000000-0000-4000-8000-000000000002', question: '专项附加扣除怎么填？', helpful: 1,
  answers: [{ ...post.answers[0]!, id: '00000000-0000-4000-8000-0000000000a2', text: '在个税 App 里填报 [1][2]。', pinned: false, helpful: 1,
    citations: [{ index: 1, knowledgeId: '00000000-0000-4000-8000-0000000000e1', title: '个人所得税法实施条例', kind: 'document', locator: {}, excerpt: '……' }] }],
};
vi.mock('@/lib/services/public-rees', async (original) => ({ ...(await original<typeof import('@/lib/services/public-rees')>()), publicReeBySlug: async () => (state.sparse ? { ...ree, sources: 0, answers: 0, sampleQuestions: [] } : { ...ree, visitorAsks: state.visitorAsks }) }));
vi.mock('@/lib/services/posts', async (original) => ({ ...(await original<typeof import('@/lib/services/posts')>()), reePostPicks: async () => (state.sparse ? { items: [], total: 0 } : { items: [post, second], total: 4 }) }));
vi.mock('@/lib/services/share-landing', () => ({
  reeSourceMix: async () => (state.sparse ? [] : [{ kind: 'document', count: 2 }, { kind: 'page', count: 1 }]),
  reeCitedSources: async () => (state.sparse ? [] : [{ knowledgeId: '00000000-0000-4000-8000-0000000000e1', title: '个人所得税法实施条例', kind: 'document', answers: 2 }]),
}));

const SharePage = (await import('@/app/s/[slug]/page')).default;
const { ReeDetailView } = await import('@/components/discover/ree-detail-view');

const wrap = (element: ReactElement) => renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: element }));
const share = async () => wrap((await SharePage({ params: Promise.resolve({ slug: 'tax' }), searchParams: Promise.resolve({}) })) as ReactElement);
const reePage = (viewerId?: string) =>
  wrap(
    createElement(ReeDetailView, {
      savedRee: ree, query: {}, viewerId, preview: false, related: null, author: null, video: null,
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
  state.sparse = false;
  state.visitorAsks = false;
});

/** The box 向 {name} 提问 at the foot of the share page. */
function expectBox(html: string) {
  expect(html).toContain('aria-label="向 个税顾问 提问"');
  expect(html).toMatch(/<span class="fu-chip ask-chip">.*个税顾问<\/span>/);
  expect(html).toContain('role="radiogroup" aria-label="谁能看到"');
}

describe('the share page', () => {
  it('is a landing page: one real exchange, questions to try, its sources, more answers and the box', async () => {
    const html = await share();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1 [^>]*>个税顾问<\/h1>/);
    /* The top pick beside the hero, its citation markers dropped. */
    expect(html).toContain('class="share-proof"');
    expect(html).toContain('年度汇算什么时候办？');
    expect(html).toContain('每年 3 月 1 日至 6 月 30 日。');
    expect(html).not.toContain('[1]');
    /* 可以这样问它, its sources by kind and the ones public answers cited. */
    expect(html).toContain('租房扣除每个月能扣多少？');
    expect(html).toContain('文档<strong class="font-mono text-[13px]">2</strong>');
    expect(html).toContain('个人所得税法实施条例');
    expect(html).toContain('被 2 个回答引用');
    /* The other picks, and the way to all of them. */
    expect(html).toContain('专项附加扣除怎么填？');
    expect(html).toContain('4 个公开帖子中的精选');
    expect(html).toContain('查看全部 4 个帖子');
    expectBox(html);
    expect(html).toContain(`href="/login?returnTo=${encodeURIComponent('/s/tax#ask')}"`);
    expect(html).toContain('>登录后提问<span class="workspace-link-progress"');
    expect(html).not.toContain('开始对话');
    expect(html).not.toContain('免登录试聊');
  });

  it('gives a signed-in reader the composer naming the Ree', async () => {
    state.user = { id: '00000000-0000-4000-8000-0000000000d1' };
    const html = await share();
    expectBox(html);
    expect(html).not.toContain('登录后提问');
    expect(html).toContain('placeholder="向 个税顾问 提问…"');
    expect(html).toContain('>发布</button>');
  });

  it('lets a visitor ask right there when the owner allows it, saying first that the question is public and the owner pays', async () => {
    state.visitorAsks = true;
    const html = await share();
    expect(html).toContain('aria-label="向 个税顾问 提问"');
    expect(html).toContain('class="post-form visitor-ask"');
    expect(html).toContain(t.posts.visitorAsk.badge);
    expect(html).toContain('不用登录就能问它：问题会公开发布，回答的费用由 王税务 承担。登录后还可以私密提问。');
    expect(html).toContain('你的问题会以「一位访客」的名义公开发布，所有人可见；审核通过后由 个税顾问 回答，费用由发布者承担。');
    expect(html).toMatch(/<button type="button" class="btn btn-sm" disabled="">提问<\/button>/);
    expect(html).toContain('>或登录后用自己的账号提问<span class="workspace-link-progress"');
    /* No 公开帖子 / 私密提问 choice: a visitor's question is always public. */
    expect(html).not.toContain('role="radiogroup" aria-label="谁能看到"');
    /* Signed in, the composer as before. */
    state.user = { id: '00000000-0000-4000-8000-0000000000d1' };
    const signedIn = await share();
    expect(signedIn).not.toContain('visitor-ask');
    expect(signedIn).toContain('>发布</button>');
  });

  it('leaves out what a Ree without sources or answers does not have', async () => {
    state.sparse = true;
    const html = await share();
    expect(html).toContain('知识还在准备中');
    expect(html).not.toContain('share-proof');
    expect(html).not.toContain('可以这样问它');
    expect(html).not.toContain('它的回答从哪里来');
    expect(html).not.toContain('大家问过的');
    expect(html).not.toContain('share-closing');
    expect(html).not.toContain('id="ask"');
  });
});

describe('the Ree page', () => {
  it('has one h1, the profile\'s name, and no ?from= in its links (GSC review 2026-11, A2 / A12)', () => {
    for (const html of [reePage(), reePage('00000000-0000-4000-8000-0000000000d1')]) {
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      expect(html).toMatch(/<h1 [^>]*>个税顾问<\/h1>/);
      expect(html).not.toContain('from=');
      expect(html).not.toContain('from%3D');
    }
  });

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
