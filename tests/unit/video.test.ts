/**
 * Step 7 rules without the database: characters, the 15-second frame,
 * style patches, export pricing, the cache identity, the downloaded script,
 * the suggested video type and the browsers refused.
 */
import { describe, expect, it } from 'vitest';
import { VIDEO_FRAMES } from '@/lib/constants';
import { recommendedTemplate, storyTemplate, type ManualStory, type ProductDemo } from '@/lib/domain/product-demo';
import {
  canonicalJson,
  chars,
  clock,
  exportBrowserRefused,
  exportCost,
  introSize,
  parseVideoPatch,
  scriptDownload,
  type IntroProps,
  type VideoScenes,
} from '@/lib/domain/video';

const CUES = [
  { text: 'Setting up the DW200 takes a minute.', start: 6, end: 80 },
  { text: 'Mount it and connect power.', start: 90, end: 170 },
  { text: 'Tap Settings, then Access, to add a card.', start: 180, end: 260 },
  { text: 'Keep the reader dry.', start: 270, end: 348 },
];
const MANUAL: ManualStory = {
  kind: 'user-manual', subject: 'DW200 terminal', headline: 'Set up the DW200', summary: 'A quick start for the access terminal.',
  setup: ['Mount the bracket', 'Connect power'], operation: { title: 'Add a card', detail: 'Settings › Access › Add card' },
  caution: { title: 'Keep it dry', text: 'Water damages the reader.' }, steps: ['Set up', 'Operate', 'Caution'],
  cues: CUES, audioId: 'a', playbackRate: 1,
};
const SCENES: VideoScenes = {
  demo: MANUAL,
  opening: { name: '退款小助手', position: '按你的退款政策回答' },
  sources: { titles: ['退款政策', '积分规则'] },
  answer: { question: '退款多久到账？', answer: '原路退回，14 天内到账。' },
  closing: { cta: '现在就问它' },
};

describe('characters and the frame', () => {
  it('counts characters, not bytes or UTF-16 units', () => {
    expect(chars('退款小助手')).toBe(5);
    expect(chars('🙂🙂')).toBe(2);
    expect(chars('Refund')).toBe(6);
  });

  it('formats the clock and sizes both aspects at 720p', () => {
    expect(VIDEO_FRAMES).toBe(360);
    expect(clock(0)).toBe('00:00');
    expect(clock(359)).toBe('00:14');
    expect(clock(360)).toBe('00:15');
    expect(introSize('16:9')).toEqual({ width: 1280, height: 720 });
    expect(introSize('9:16')).toEqual({ width: 720, height: 1280 });
  });
});

describe('style patches', () => {
  it('accepts the four video types and refuses the retired templates', () => {
    expect(parseVideoPatch({ revision: 2, template: 'course-intro', accent: '#AABBCC', music: false })).toEqual({
      patch: { template: 'course-intro', accent: '#aabbcc', music: false },
      revision: 2,
    });
    expect(parseVideoPatch({ template: 'user-manual' })).toEqual({ error: 'invalid_revision' });
    expect(parseVideoPatch({ revision: 1, template: 'blueprint' })).toEqual({ error: 'invalid_template' });
    expect(parseVideoPatch({ revision: 1, accent: 'blue' })).toEqual({ error: 'invalid_accent' });
    expect(parseVideoPatch({ revision: 1, aspect: '4:3' })).toEqual({ error: 'invalid_aspect' });
    expect(parseVideoPatch({ revision: 1, music: 'yes' })).toEqual({ error: 'invalid_music' });
    /* The script itself is only ever generated. */
    expect(parseVideoPatch({ revision: 1, scenes: SCENES })).toEqual({ patch: {}, revision: 1 });
  });
});

describe('video types', () => {
  it('reads a story’s type, treating demos made before the other types as product demos', () => {
    const legacy = { ...MANUAL, kind: undefined, exampleTitle: 'x', exampleText: 'y', result: 'z' } as unknown as ProductDemo;
    expect(storyTemplate(legacy)).toBe('product-demo');
    expect(storyTemplate(MANUAL)).toBe('user-manual');
  });

  it('suggests a type from the Ree’s name, introduction and sources', () => {
    const ree = { name: 'Helper', description: '', titles: [] as string[], kinds: ['document'] };
    expect(recommendedTemplate({ ...ree, name: 'DW200 manual' })).toBe('user-manual');
    expect(recommendedTemplate({ ...ree, titles: ['DW200 用户手册.pdf'] })).toBe('user-manual');
    expect(recommendedTemplate({ ...ree, titles: ['Week 1 lesson slides'] })).toBe('course-intro');
    expect(recommendedTemplate({ ...ree, description: '摄影入门课程' })).toBe('course-intro');
    expect(recommendedTemplate({ ...ree, titles: ['Why we left the cloud — blog'] })).toBe('article-summary');
    expect(recommendedTemplate({ ...ree, kinds: ['page', 'page', 'document'] })).toBe('article-summary');
    expect(recommendedTemplate(ree)).toBe('product-demo');
    expect(recommendedTemplate({ ...ree, kinds: [] })).toBe('product-demo');
  });
});

describe('exports and the script file', () => {
  it('makes each Ree’s first export free and uses the configured price for later exports', () => {
    expect(exportCost(0, 65)).toBe(0);
    expect(exportCost(1, 65)).toBe(65);
    expect(exportCost(7, 65)).toBe(65);
  });

  it('hashes props the same whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: 'x' } })).toBe(canonicalJson({ a: { c: 'x', d: [1, { e: 3, f: 2 }] }, b: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('downloads the story with its spec and caption timings, without the private audio id', () => {
    const props: IntroProps = { template: 'user-manual', accent: '#127ee3', aspect: '16:9', music: true, scenes: SCENES, ree: { avatarUrl: null, color: 'default', price: 20, slug: 'refunds', shareUrl: null, sourcesTotal: 2 } };
    const file = scriptDownload('退款小助手', props);
    expect(file).toMatchObject({ ree: '退款小助手', duration: 15, fps: 24, resolution: '720p', aspect: '16:9', template: 'user-manual', subject: 'DW200 terminal', setup: MANUAL.setup });
    expect(file).not.toHaveProperty('audioId');
    expect((file.captions as { start: number }[]).map((caption) => caption.start)).toEqual([0.25, 3.75, 7.5, 11.25]);
  });
});

describe('export browsers', () => {
  const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
  const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
  const WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0';
  const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1';
  const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0';

  it('refuses Safari and phones before probing; desktop Chrome, Edge and Firefox go on to the probe', () => {
    expect(exportBrowserRefused(MAC_SAFARI)).toBe(true);
    expect(exportBrowserRefused(IPHONE_CHROME)).toBe(true);
    expect(exportBrowserRefused(MAC_CHROME)).toBe(false);
    expect(exportBrowserRefused(WIN_EDGE)).toBe(false);
    expect(exportBrowserRefused(FIREFOX)).toBe(false);
  });
});
