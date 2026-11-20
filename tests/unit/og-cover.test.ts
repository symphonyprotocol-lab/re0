/**
 * Posts' link previews (封面图设计稿, 2026-11-20): the cuts before satori's
 * line clamp, the answer excerpt's cleaning, the cover's version, and the
 * post page's Open Graph tags for each state of a post.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coverExcerpt, coverVersion, ems, fitLines, fitText } from '@/lib/og/text';
import { postCoverPath, postMetadata } from '@/lib/og/post-meta';
import type { PostCover } from '@/lib/services/posts';

beforeEach(() => vi.stubEnv('APP_BASE_URL', 'https://re0.io/'));
afterEach(() => vi.unstubAllEnvs());

describe('fitLines', () => {
  it('leaves what fits alone, folding whitespace', () => {
    expect(fitText('  How do  I\ndeploy? ', 40)).toBe('How do I deploy?');
    expect(fitLines('How do I deploy a Next.js app with a Postgres database on a single small VPS?', 1072 / 54, 2, true)).toBe('How do I deploy a Next.js app with a Postgres database on a single small VPS?');
  });

  it('cuts Chinese anywhere, with an ellipsis and no trailing punctuation', () => {
    expect(fitText('一二三四五六七八，十一十二十三', 10)).toBe('一二三四五六七八…');
    const cut = fitLines('我在杭州工作三年，社保和公积金都在杭州交，现在准备回老家成都发展，社保要不要转移？公积金能不能提取出来？', 1072 / 54, 2, true);
    expect(cut).toBe('我在杭州工作三年，社保和公积金都在杭州交，现在准备回老家成都发展，社保要不…');
  });

  it('cuts English after the last whole word of the last line', () => {
    expect(fitLines('My landlord in Berlin is asking for a 15% rent increase after only one year, citing renovations to the building we never asked for.', 1072 / 54, 2, true)).toBe('My landlord in Berlin is asking for a 15% rent increase after only one year…');
    expect(fitText('My landlord in Berlin is asking for a fifteen percent rent increase', 12)).toBe('My landlord in Berlin is…');
  });

  it('cuts a word longer than a line by its characters', () => {
    expect(fitText('Supercalifragilisticexpialidocious', 6)).toBe('Supercali…');
  });

  it('counts CJK as one em and Latin as about half, wider in bold', () => {
    expect(ems('提问')).toBe(2);
    expect(ems('提问', true)).toBe(2);
    expect(ems('ab')).toBeCloseTo(1.0712);
    expect(ems('ab', true)).toBeCloseTo(1.092);
  });
});

describe('coverExcerpt', () => {
  it('is plain text without citation markers', () => {
    expect(coverExcerpt('**Yes.** Run [Caddy](https://caddyserver.com) in front [1][2].\n\n- back up nightly [3]', 'en')).toBe('Yes. Run Caddy in front. back up nightly');
  });

  it('hides phone numbers and e-mail addresses an answer quoted from its sources', () => {
    const zh = coverExcerpt('可以先拨打 13812345678 咨询，或写信到 help@example.com [2]。', 'zh');
    expect(zh).not.toMatch(/13812345678|help@example\.com|\[2\]/);
    expect(zh).toContain('[已隐去]');
    expect(coverExcerpt('Call +1 415 555 0134 or mail jane.doe@example.org.', 'en')).not.toMatch(/555|jane/);
  });
});

describe('coverVersion', () => {
  const base = { question: 'Q?', lang: 'en', answers: 2, firstAnswerId: 'a1', firstText: 'Yes.' };

  it('is stable for the same picture and short enough for a URL', () => {
    expect(coverVersion(base)).toBe(coverVersion({ ...base }));
    expect(coverVersion(base)).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it('changes with a new answer, a new first answer, an edited question or another language', () => {
    const versions = new Set([coverVersion(base), coverVersion({ ...base, answers: 3 }), coverVersion({ ...base, firstAnswerId: 'a2' }), coverVersion({ ...base, question: 'Q2?' }), coverVersion({ ...base, lang: 'zh' }), coverVersion({ ...base, firstText: 'No.' })]);
    expect(versions.size).toBe(6);
  });
});

describe('postMetadata', () => {
  const id = '6f1c3c1e-8a3b-4d2e-9b1f-0c2d3e4f5a6b';
  const shown: Extract<PostCover, { state: 'shown' }> = {
    state: 'shown',
    lang: 'zh',
    question: '租房合同还没到期，房东要求提前收回房子，押金怎么算？',
    detail: '',
    answers: 2,
    rees: [{ name: '租房法律助手', avatar: null, color: 'sage' }, { name: '消费维权指南', avatar: null, color: 'rose' }],
    first: { id: 'a1', name: '租房法律助手', avatar: null, color: 'sage', text: '属于房东违约 [1]。', helpful: 3 },
  };

  it('names the versioned cover for Open Graph and a large Twitter card', () => {
    const meta = postMetadata(id, shown, 'en');
    const image = { url: postCoverPath(id, shown), width: 1200, height: 630 };
    expect(image.url).toMatch(new RegExp(`^/og/p/${id}\\?v=[A-Za-z0-9_-]{12}$`));
    expect(meta.openGraph).toMatchObject({ type: 'article', url: `https://re0.io/en/p/${id}`, images: [image] });
    expect(meta.twitter).toMatchObject({ card: 'summary_large_image', images: [image] });
    expect(meta.robots).toBeUndefined();
  });

  it('gives a new image URL once another Ree answers', () => {
    const more = { ...shown, answers: 3, rees: [...shown.rees, { name: 'Third', avatar: null, color: 'default' }] };
    expect(postCoverPath(id, more)).not.toBe(postCoverPath(id, shown));
  });

  it('keeps an unanswered post out of search, cover and all', () => {
    const meta = postMetadata(id, { ...shown, answers: 0, rees: [], first: null }, 'zh');
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.twitter).toMatchObject({ card: 'summary_large_image' });
  });

  it('gives away nothing of a private post: no image, no question, no index', () => {
    for (const cover of [{ state: 'private' } as const, null]) {
      const meta = postMetadata(id, cover, 'zh');
      expect(meta.title).toEqual({ absolute: 'RE0' });
      expect(meta.robots).toEqual({ index: false, follow: true });
      expect(meta.openGraph && 'images' in meta.openGraph).toBe(false);
      expect(meta.twitter && 'images' in meta.twitter).toBe(false);
      expect(JSON.stringify(meta)).not.toContain('/og/p/');
    }
  });

  it('shows the site image in the page language for a hidden, deleted or unapproved post', () => {
    const meta = postMetadata(id, { state: 'gone', lang: 'en' }, 'zh');
    expect(meta.openGraph).toMatchObject({ images: [{ url: '/og/site/zh', alt: 'RE0 — 问一次，多个 Ree 来回答。' }] });
    expect(meta.twitter).toMatchObject({ card: 'summary_large_image', images: [{ url: '/og/site/zh' }] });
    expect(meta.robots).toEqual({ index: false, follow: true });
  });
});
