/**
 * AI 通用回答 (design draft 1, approved 2026-11-20): what the model is told
 * and what is kept of its text, and how the asker's card, its guidance, its
 * folded line, the skipped state and their own feed card read -- and that a
 * post without one (anyone else's view) reads as before.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import { fill } from '@/i18n/format';
import { aiAnswerInstructions, aiAnswerPrompt, cleanAiAnswer } from '@/lib/domain/ai-answer';
import { AI_ANSWER_FEE, type AiAnswerView, type FollowupView, type PostView } from '@/lib/domain/post';
import { QUERY_BASE_FEE } from '@/lib/constants';

vi.mock('next/navigation', () => ({ usePathname: () => '/p/x', useRouter: () => ({ refresh: () => {}, push: () => {} }), useSearchParams: () => new URLSearchParams() }));

const { PostDetail } = await import('@/components/posts/post-detail');
const { PostCard } = await import('@/components/posts/post-card');

const zh = messages('zh');
const en = messages('en');
const a = zh.posts.ai;
/* The unmatched line up to its quoted word (the markup escapes the quotes). */
const unmatched = zh.posts.card.unmatched.split('。')[0]!;

const answered: AiAnswerView = { id: 'ai1', state: 'answered', text: '叶子发黄**又卷边**，常见原因：浇水过多。', truncated: false, vote: null, cost: AI_ANSWER_FEE, retry: false, folded: false };
const base: PostView = {
  id: '00000000-0000-4000-8000-000000000001', visibility: 'public', title: null, pinned: false, archived: false, publishedCopyId: null, question: '龟背竹叶子发黄卷边？', detail: '', lang: 'zh', category: null,
  author: { kind: 'user', name: '林夏', avatar: null, mine: true }, status: 'published', answerState: 'done', answered: 0, candidates: 4, skipped: 4,
  helpful: 0, voted: false, saved: false, createdAt: '2026-11-20T00:00:00.000Z', answers: [],
  summary: null, summaryStale: false, summaryRewriteFree: false, hiddenBy: null, quote: null, quotes: 0, paidRequests: [], spent: null,
  aiAnswer: answered, followupCount: 0, followups: [], followupCandidates: [], followupBlocked: null, deleted: false,
};
const now = Date.parse('2026-11-20T01:00:00Z');
const page = (post: PostView) => renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t: zh, children: createElement(PostDetail, { initial: post, signedIn: true, now, loginHref: '/login' }) }));
const card = (post: PostView) => renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t: zh, children: createElement(PostCard, { post, now, signedIn: true }) }));

describe('the model is a general assistant with no sources', () => {
  it('tells it what it is not, to cite nothing, to keep it short and when to add a disclaimer', () => {
    for (const lang of ['zh', 'en'] as const) {
      const text = aiAnswerInstructions(lang);
      expect(text).toMatch(/not a Ree/);
      expect(text).toMatch(/Give no sources/);
      expect(text).toMatch(/\[1\]/);
      expect(text).toMatch(/not sure/);
      expect(text).toMatch(/medical, legal, financial or psychological/);
      expect(text).toMatch(/illegal or dangerous/);
    }
    expect(aiAnswerInstructions('zh')).toContain('400 Chinese characters');
  });

  it('asks the question alone, or a follow-up with the thread so far', () => {
    expect(aiAnswerPrompt('Why yellow?', 'Indoors.')).toBe('Why yellow?\n\nIndoors.');
    const prompt = aiAnswerPrompt('And in winter?', '', { postQuestion: 'Why yellow?', earlierAnswer: 'Overwatering.', earlierQuestions: ['q1', 'q2'] });
    expect(prompt).toContain('The original question:\nWhy yellow?');
    expect(prompt).toContain('Your earlier general answer to it:\nOverwatering.');
    expect(prompt).toContain('- q1\n- q2');
    expect(prompt.endsWith('The follow-up question to answer now:\nAnd in winter?')).toBe(true);
  });

  it('keeps none of the citation markers it wrote, and hides contact details like a post', () => {
    expect(cleanAiAnswer('Water less [1] and more [^2] now 【3】.', 'en')).toBe('Water less and more now.');
    expect(cleanAiAnswer('A [link](https://example.com/x) stays a link.', 'en')).not.toContain('example.com');
    expect(cleanAiAnswer('打 13812345678 问问', 'zh')).not.toContain('13812345678');
    expect(cleanAiAnswer(' [1] ', 'en')).toBe('');
  });
});

describe('the asker reads the AI answer, marked as no Ree’s', () => {
  it('shows the state line, the card with its tags, note and cost, the guidance, and no Ree mark or citation', () => {
    const html = page(base);
    expect(html).toContain(a.stateStrong);
    expect(html).toContain('post-answer ai-answer');
    expect(html).toContain(`>${a.title}</strong>`);
    expect(html).toContain(a.noSource);
    expect(html).toContain(a.onlyYou);
    expect(html).toContain(a.note);
    expect(html).toContain('<strong>又卷边</strong>');
    expect(html).toContain(`>${fill(a.cost, { n: String(AI_ANSWER_FEE) })}</span>`);
    for (const label of [a.helpful, a.unhelpful, a.copy]) expect(html).toContain(`</svg>${label}</button>`);
    expect(html).toContain(a.guideTitle);
    for (const label of [a.rephrase, a.mention, a.create]) expect(html).toContain(`<strong>${label}</strong>`);
    /* 换个说法再问 opens the composer with the question in it. */
    expect(html).toContain('compose=public&amp;ask=');
    /* No "nobody could answer" line and no follow-up box: nobody to ask on. */
    expect(html).not.toContain(unmatched);
    expect(html).not.toContain(zh.posts.followupComposer.placeholder);
  });

  it('reads as before for anyone else: no card, the unmatched line', () => {
    const html = page({ ...base, author: { kind: 'user', name: '林夏', avatar: null, mine: false }, aiAnswer: null });
    expect(html).not.toContain('ai-answer');
    expect(html).not.toContain(a.guideTitle);
    expect(html).toContain(unmatched);
  });

  it('folds to one line under the Rees once one answered', () => {
    const ree = { id: 'r-a', reeId: 'r1', reeSlug: 'plants', reeName: '绿植顾问', reeAvatar: null, reeColor: 'default', official: false, similarity: null, state: 'answered' as const, text: '浇水过多。', truncated: false, citations: [], helpful: 0, voted: false, pinned: false, paid: false, unhelpful: 0, unvoted: false, cost: null };
    const html = page({ ...base, answered: 1, answers: [ree], aiAnswer: { ...answered, folded: true } });
    expect(html).toContain(a.folded);
    expect(html).not.toContain(a.note);
    expect(html.indexOf('绿植顾问')).toBeLessThan(html.indexOf(a.folded));
    expect(html).not.toContain(a.stateStrong);
  });

  it('says a short balance skipped it, with the top-up and the one-time button', () => {
    const html = page({ ...base, aiAnswer: { ...answered, state: 'skipped_balance', text: '', cost: 0, retry: true } });
    expect(html).toContain(fill(a.skipped, { fee: String(AI_ANSWER_FEE) }));
    expect(html).toContain('/settings?tab=balance');
    expect(html).toContain(fill(a.generate, { fee: String(AI_ANSWER_FEE) }));
    expect(html).toContain(unmatched);
  });

  it('shows the private author the AI-only state and 加 Ree', () => {
    const html = page({ ...base, visibility: 'private', candidates: 0, skipped: 0 });
    expect(html).toContain(a.stateAiOnly);
    expect(html).toContain(`<strong>${a.addRee}</strong>`);
    expect(html).not.toContain(`<strong>${a.create}</strong>`);
  });

  it('answers the asker of a follow-up no Ree answered; anyone else reads the line as before', () => {
    const round: FollowupView = {
      id: 'f1', author: { name: '林夏', avatar: null, poster: false, mine: true }, question: '断缴一个月影响买房吗？', mentions: [], status: 'published', hiddenBy: null, answerState: 'done',
      candidates: 1, skipped: 1, createdAt: '2026-11-20T00:30:00.000Z', answers: [], awaiting: 0, paidRequests: [], declined: [], spent: 0, aiAnswer: { ...answered, text: '取决于城市的规则。' },
    };
    const ree = { id: 'r-a', reeId: 'r1', reeSlug: 'plants', reeName: '社保顾问', reeAvatar: null, reeColor: 'default', official: false, similarity: 0.8, state: 'answered' as const, text: '要连续缴纳。', truncated: false, citations: [], helpful: 0, voted: false, pinned: false, paid: false, unhelpful: 0, unvoted: false, cost: null };
    const post: PostView = { ...base, author: { kind: 'user', name: 'Mei', avatar: null, mine: false }, aiAnswer: null, answered: 1, answers: [ree], followupCount: 1, followups: [round], followupCandidates: [{ reeId: 'r1', reeSlug: 'plants', reeName: '社保顾问', reeAvatar: null, reeColor: 'default', price: QUERY_BASE_FEE, paid: false }] };
    const mine = page(post);
    expect(mine).toContain(a.followupNote);
    expect(mine).toContain('取决于城市的规则。');
    expect(mine).toContain(`<strong>${a.postAnew}</strong>`);
    expect(mine).not.toContain(zh.posts.followups.noAnswerMine);
    const theirs = page({ ...post, followups: [{ ...round, author: { ...round.author, mine: false }, aiAnswer: null, spent: null }] });
    expect(theirs).not.toContain('取决于城市的规则。');
    expect(theirs).toContain(zh.posts.followups.noAnswer);
    /* The box says the AI steps in when no Ree can, at the base fee. */
    expect(mine).toContain(fill(a.followupCost, { fee: String(QUERY_BASE_FEE) }));
  });

  it('previews it on the asker’s own feed card, in place of "nobody could answer"', () => {
    const html = card({ ...base, aiAnswer: { ...answered, text: '叶子发黄又卷边，常见原因：浇水过多…', truncated: true } });
    expect(html).toContain('ai-preview');
    expect(html).toContain(a.preview);
    expect(html).toContain('常见原因：浇水过多');
    expect(html).not.toContain(unmatched);
    const theirs = card({ ...base, author: { kind: 'user', name: '林夏', avatar: null, mine: false }, aiAnswer: null });
    expect(theirs).not.toContain('ai-preview');
    expect(theirs).toContain(unmatched);
  });
});

describe('the copy', () => {
  it('prices it at the base fee on the pricing table, the FAQ, the terms and the composer', () => {
    for (const t of [zh, en]) {
      expect(t.site.pricing.costs.aiAnswer.cost).toContain('{postBaseFee}');
      expect(t.site.faq.q9.a).toContain('{postBaseFee}');
      expect(t.legal.terms.s10.body.length).toBeGreaterThan(0);
      expect(t.posts.composer.cost).toContain('{fee}');
    }
    expect(zh.legal.terms.s10.body).toContain('AI 通用回答由模型按通用知识生成');
    expect(en.legal.terms.s10.body).toContain('AI general answers are generated by a model');
    expect(zh.notices.lines.postAiAnswer).toContain('{question}');
    expect(AI_ANSWER_FEE).toBe(QUERY_BASE_FEE);
  });
});
