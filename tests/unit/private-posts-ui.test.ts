/**
 * 私密提问 as a private post (design 稿 2, 2026-11-20), the pages: the post
 * page shows its mark and the owner's actions and none of the public ones;
 * a public post looks as before; the composer's private tab lists the Rees
 * it will ask with their prices; 我的帖子 › 私密 lists post cards.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import type { PostView, PrivateReeOption } from '@/lib/domain/post';

vi.mock('next/navigation', () => ({ usePathname: () => '/p/x', useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));

const { PostDetail } = await import('@/components/posts/post-detail');
const { PostFeed } = await import('@/components/posts/post-feed');
const { PrivatePostForm } = await import('@/components/posts/composer');
const { MyPostsFilter, MyPostsTabs, parseMineFilter } = await import('@/components/posts/my-posts-tabs');

const t = messages('zh');
const answer = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id: `00000000-0000-4000-8000-0000000000a${id}`, reeId: `00000000-0000-4000-8000-0000000000b${id}`, reeSlug: id, reeName: name, reeAvatar: null, reeColor: 'default', official: false, similarity: 0.8, state: 'answered' as const, text: '不需要重新填写 [1]。', truncated: false, citations: [], helpful: 2, voted: false, pinned: false, paid: false, unhelpful: 0, unvoted: false, cost: null, ...extra });
const candidate = (id: string, name: string, price: number) => ({ reeId: `00000000-0000-4000-8000-0000000000b${id}`, reeSlug: id, reeName: name, reeAvatar: null, reeColor: 'default', price, paid: price > 20 });
const base: PostView = {
  id: '00000000-0000-4000-8000-000000000001', visibility: 'public', title: null, pinned: false, archived: false, publishedCopyId: null, question: '换工作后，个税的专项附加扣除需要重新填吗？', detail: '', lang: 'zh', category: 'business',
  author: { kind: 'user', name: 'Lin', avatar: null, mine: false }, status: 'published', answerState: 'done', answered: 2, candidates: 6, skipped: 0,
  helpful: 4, voted: false, saved: false, createdAt: '2026-11-20T00:00:00.000Z',
  answers: [answer('1', '个税顾问'), answer('2', '社保公积金')],
  summary: null, summaryStale: false, summaryRewriteFree: false, hiddenBy: null, quote: null, quotes: 0, paidRequests: [], spent: null, aiAnswer: null, followupCount: 0, followups: [],
  followupCandidates: [candidate('1', '个税顾问', 20), candidate('2', '社保公积金', 50)], followupBlocked: null, deleted: false,
};
const privatePost: PostView = {
  ...base,
  visibility: 'private',
  category: null,
  author: { kind: 'user', name: 'Lin', avatar: null, mine: true },
  answers: [answer('1', '个税顾问', { similarity: null, cost: 20 }), answer('2', '社保公积金', { similarity: null, cost: 50 })],
  spent: 70,
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const render = (node: (props: any) => React.ReactNode, props: Record<string, unknown>) => renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: createElement(node as never, props as never) }));
const page = (post: PostView) => render(PostDetail, { initial: post, signedIn: true, now: Date.parse('2026-11-20T01:00:00Z'), loginHref: '/login' });

describe('a private post\'s page', () => {
  const html = page(privatePost);

  it('marks it private where the category was, and offers the owner\'s actions', () => {
    expect(html).toContain('<span class="private-badge">');
    expect(html).toContain('私密 · 仅你可见');
    for (const label of ['置顶', '归档', '重命名', '转为公开', '移到回收站']) expect(html).toContain(`</svg>${label}</button>`);
  });

  it('gives each answer 有帮助 · 没帮助 · 复制 · 继续问 and its cost, without a match score', () => {
    expect(html).toContain('</svg>没帮助</button>');
    expect(html).toContain('</svg>复制</button>');
    expect(html).toContain('继续问 个税顾问');
    expect(html).toContain('<span class="answer-cost">50 credits</span>');
    expect(html).not.toContain('post-match');
    expect(html).toContain('你选的 2 个 Ree');
    expect(html).toContain('这次提问共扣了你 70 credits。');
  });

  it('has none of the public actions: no 收藏, 复制链接, 引用, 举报', () => {
    for (const label of ['收藏', '复制链接', '引用', '举报']) expect(html).not.toContain(label);
  });

  it('lets the thread add Rees, and links the public copy once made', () => {
    expect(html).toContain('</svg>加 Ree</button>');
    expect(html).toContain('继续问点什么？@ 指定 Ree，也可以加别的 Ree');
    expect(html).toContain('最多 70 credits · 没有回答不收费');
    const converted = page({ ...privatePost, publishedCopyId: '00000000-0000-4000-8000-000000000009' });
    expect(converted).toMatch(/href="[^"]*\/p\/00000000-0000-4000-8000-000000000009"[^>]*>.*已转为公开 →/);
    expect(converted).not.toContain('</svg>转为公开</button>');
  });

  it('leads with its title once renamed, the question under it', () => {
    const renamed = page({ ...privatePost, title: '个税扣除' });
    expect(renamed).toContain('<h2 class="post-page-question">个税扣除</h2><p class="post-page-detail">换工作后，个税的专项附加扣除需要重新填吗？</p>');
  });
});

describe('a public post\'s page, unchanged', () => {
  const html = page(base);

  it('keeps its category, 有帮助 counts, link, quote and report, and none of the private actions', () => {
    expect(html).not.toContain('private-badge');
    expect(html).toContain('<span class="tag">');
    expect(html).toContain('有帮助 2');
    expect(html).toContain('title="复制链接"');
    expect(html).toContain('引用提问');
    expect(html).toContain('举报帖子');
    expect(html).toContain('匹配 0.80');
    for (const label of ['置顶', '归档', '重命名', '转为公开', '没帮助', '加 Ree']) expect(html).not.toContain(label);
  });
});

describe('the composer\'s private tab', () => {
  const rees: PrivateReeOption[] = [{ ...candidate('1', '个税顾问', 20), similarity: 0.7 }, { ...candidate('2', '社保公积金', 50), similarity: 0.6 }];

  it('shows the Rees it will ask with their prices, 选 Ree, and the most it can cost', () => {
    const html = render(PrivatePostForm, { rees, question: '换工作后要重新填吗？' });
    expect(html).toMatch(/<span class="fu-chip">.*?个税顾问<small>20<\/small><button type="button" aria-label="去掉 个税顾问"/);
    expect(html).toMatch(/社保公积金<small>50<\/small>/);
    expect(html).toContain('</svg>选 Ree</button>');
    expect(html).toContain('最多 70 credits · 没有回答不收费');
    expect(html).toContain('</svg>私密提问</button>');
  });

  it('without a Ree, offers to ask the AI alone at the base fee (只问 AI)', () => {
    const html = render(PrivatePostForm, { question: '换工作后要重新填吗？' });
    expect(html).not.toContain('最多 0 credits');
    expect(html).toContain('20 credits · 生成失败不收费');
    expect(html).toContain('</svg>只问 AI · 20 credits</button>');
    expect(html).not.toContain('</svg>私密提问</button>');
    /* Nothing to ask yet: no button to send. */
    expect(render(PrivatePostForm, {})).toMatch(/<button type="button" class="btn btn-sm" title="[^"]*" disabled="">/);
  });
});

describe('我的帖子 › 私密', () => {
  it('lists private post cards: the mark, the rename, pinned, and no 有帮助 / 收藏 / 复制链接', () => {
    const items = [{ ...privatePost, title: '个税扣除', pinned: true, answers: privatePost.answers.slice(0, 1) }, { ...privatePost, id: '00000000-0000-4000-8000-000000000002', answers: [] }];
    const html = render(PostFeed, { tab: 'latest', initial: { items, next: null }, now: 0, signedIn: true });
    expect(html.match(/<article class="post-card"/g)).toHaveLength(2);
    expect(html.match(/class="private-badge"/g)).toHaveLength(2);
    expect(html).toMatch(/>个税扣除<span class="workspace-link-progress"/);
    expect(html).toContain('已置顶');
    expect(html).not.toContain('title="有帮助"');
    expect(html).not.toContain('收藏');
    expect(html).not.toContain('复制链接');
  });

  it('counts every tab and offers 筛选 wired to the address', () => {
    const tabs = renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: createElement(MyPostsTabs, { t, locale: 'zh', tab: 'private', counts: { all: 5, public: 3, private: 2, trash: 0 } }) }));
    expect(tabs).toMatch(/全部<span>5<\/span>/);
    expect(tabs).toMatch(/aria-selected="true" class="workspace-link cl-tab active" href="\/me\/posts\?tab=private">私密<span>2<\/span>/);
    const filter = renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: createElement(MyPostsFilter, { t, query: { pinned: '1' }, rees: [{ id: 'r1', name: '个税顾问' }] }) }));
    expect(filter).toContain('class="my-posts-filter is-active"');
    expect(filter).toContain('<option value="r1">个税顾问</option>');
    expect(filter).toMatch(/name="pinned" checked="" value="1"/);
  });

  it('reads the filter from the address, dropping anything malformed', () => {
    const now = Date.parse('2026-11-20T00:00:00Z');
    const { filter, query } = parseMineFilter({ q: ' 个税 ', ree: 'nope', days: '30', pinned: '1', archived: '0' }, now);
    expect(query).toEqual({ q: '个税', days: '30', pinned: '1' });
    expect(filter).toEqual({ q: '个税', reeId: null, since: new Date(now - 30 * 86_400_000), pinned: true, archived: false });
  });
});
