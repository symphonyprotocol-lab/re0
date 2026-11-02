/**
 * Step 7 rules without the database: shot limits counted in characters,
 * the 15-second timeline with crossfades inside it, export pricing, the
 * answer's first sentence, the cache identity and the browsers refused.
 */
import { describe, expect, it } from 'vitest';
import { VIDEO_FRAMES, VIDEO_TRANSITION_FRAMES } from '@/lib/constants';
import {
  canonicalJson,
  chars,
  clock,
  exportBrowserRefused,
  exportCost,
  firstSentence,
  introSize,
  parseVideoPatch,
  readScenes,
  sceneErrors,
  scriptDownload,
  scriptLang,
  shotAt,
  shotWindows,
  type IntroProps,
  type VideoScenes,
} from '@/lib/domain/video';
import { shotSpan } from '@/video/parts';

const SCENES: VideoScenes = {
  opening: { name: '退款小助手', position: '按你的退款政策回答' },
  sources: { titles: ['退款政策', '积分规则'] },
  answer: { question: '退款多久到账？', answer: '原路退回，14 天内到账。' },
  closing: { cta: '现在就问它' },
};

describe('shot limits', () => {
  it('counts characters, not bytes or UTF-16 units', () => {
    expect(chars('退款小助手')).toBe(5);
    expect(chars('🙂🙂')).toBe(2);
    expect(chars('Refund')).toBe(6);
  });

  it('passes a script within every limit and names each one broken', () => {
    expect(sceneErrors(SCENES)).toEqual([]);
    const broken: VideoScenes = {
      opening: { name: '一二三四五六七八九十一二三四五六七八九十一', position: '' },
      sources: { titles: ['一', '二', '三', '四', '五'] },
      answer: { question: 'Q', answer: 'x'.repeat(51) },
      closing: { cta: '十七个字的号召一二三四五六七八九十' },
    };
    expect(sceneErrors(broken)).toEqual([
      { field: 'name', issue: 'too_long', max: 20 },
      { field: 'position', issue: 'empty', max: 24 },
      { field: 'answer', issue: 'too_long', max: 50 },
      { field: 'cta', issue: 'too_long', max: 16 },
      { field: 'sources', issue: 'too_many', max: 4 },
    ]);
    expect(sceneErrors({ ...SCENES, sources: { titles: ['一二三四五六七八九十一二三四五六七八九十一'] } })).toEqual([{ field: 'source', index: 0, issue: 'too_long', max: 20 }]);
    /* Exactly at the limit is fine. */
    expect(sceneErrors({ ...SCENES, opening: { name: '一'.repeat(20), position: '二'.repeat(24) } })).toEqual([]);
  });

  it('reads a request into the four shots, tidying whitespace and refusing a wrong shape', () => {
    expect(readScenes({ ...SCENES, sources: { titles: ['  退款政策 ', '', '积分\n规则'] } })!.sources.titles).toEqual(['退款政策', '积分 规则']);
    expect(readScenes({ opening: {} })).toBeNull();
    expect(readScenes('nope')).toBeNull();
  });

  it('parses a save: style fields, scenes and the revision; over-limit text is refused, never cut', () => {
    expect(parseVideoPatch({ revision: 2, template: 'blueprint', accent: '#AABBCC', aspect: '9:16', music: false })).toEqual({
      patch: { template: 'blueprint', accent: '#aabbcc', aspect: '9:16', music: false },
      revision: 2,
    });
    expect(parseVideoPatch({ template: 'editorial' })).toEqual({ error: 'invalid_revision' });
    expect(parseVideoPatch({ revision: 1, template: 'neon' })).toEqual({ error: 'invalid_template' });
    expect(parseVideoPatch({ revision: 1, accent: 'blue' })).toEqual({ error: 'invalid_accent' });
    expect(parseVideoPatch({ revision: 1, aspect: '4:3' })).toEqual({ error: 'invalid_aspect' });
    expect(parseVideoPatch({ revision: 1, music: 'yes' })).toEqual({ error: 'invalid_music' });
    const long = parseVideoPatch({ revision: 1, scenes: { ...SCENES, closing: { cta: 'x'.repeat(17) } } });
    expect(long).toEqual({ error: 'scene_limits', errors: [{ field: 'cta', issue: 'too_long', max: 16 }] });
  });
});

describe('timeline', () => {
  it('cuts 3 + 4 + 5 + 3 seconds into 360 frames at 24 fps', () => {
    expect(shotWindows()).toEqual([
      { start: 0, end: 72 },
      { start: 72, end: 168 },
      { start: 168, end: 288 },
      { start: 288, end: 360 },
    ]);
    expect(VIDEO_FRAMES).toBe(360);
    expect([0, 71, 72, 167, 168, 287, 288, 359].map((frame) => shotAt(frame))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('keeps the 0.4 s crossfades inside the 15 seconds: half before each cut, half after', () => {
    expect(VIDEO_TRANSITION_FRAMES).toBe(10);
    expect(shotSpan(0, 72, 360)).toEqual({ from: 0, durationInFrames: 77, first: true, last: false });
    expect(shotSpan(72, 168, 360)).toEqual({ from: 67, durationInFrames: 106, first: false, last: false });
    expect(shotSpan(288, 360, 360)).toEqual({ from: 283, durationInFrames: 77, first: false, last: true });
  });

  it('formats the clock and sizes both aspects at 720p', () => {
    expect(clock(0)).toBe('00:00');
    expect(clock(359)).toBe('00:14');
    expect(clock(360)).toBe('00:15');
    expect(introSize('16:9')).toEqual({ width: 1280, height: 720 });
    expect(introSize('9:16')).toEqual({ width: 720, height: 1280 });
  });
});

describe('exports and text', () => {
  it('makes each Ree’s first export free and every later one 50', () => {
    expect(exportCost(0)).toBe(0);
    expect(exportCost(1)).toBe(50);
    expect(exportCost(7)).toBe(50);
  });

  it('takes an answer’s first sentence without citations or Markdown', () => {
    expect(firstSentence('Refunds are issued within 14 days [1]. Store credit is never forced [2].')).toBe('Refunds are issued within 14 days.');
    expect(firstSentence('**原路退回**，14 天内到账[1]。积分不退。')).toBe('原路退回，14 天内到账。');
    expect(firstSentence('No full stop here')).toBe('No full stop here');
    expect(firstSentence('Version 2.5 ships today. Then more.')).toBe('Version 2.5 ships today.');
  });

  it('captions the video in the script’s language', () => {
    expect(scriptLang(SCENES)).toBe('zh');
    expect(scriptLang({ opening: { name: 'Refunds', position: 'Policy' }, sources: { titles: ['Notes'] }, answer: { question: 'When?', answer: 'Soon.' }, closing: { cta: 'Ask' } })).toBe('en');
  });

  it('hashes props the same whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: 'x' } })).toBe(canonicalJson({ a: { c: 'x', d: [1, { e: 3, f: 2 }] }, b: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('downloads the script with its spec and shot timings', () => {
    const props: IntroProps = { template: 'editorial', accent: '#127ee3', aspect: '16:9', music: true, scenes: SCENES, ree: { avatarUrl: null, color: 'default', price: 20, slug: 'refunds', shareUrl: null, sourcesTotal: 2 } };
    const file = scriptDownload('退款小助手', props);
    expect(file).toMatchObject({ ree: '退款小助手', duration: 15, fps: 24, resolution: '720p', aspect: '16:9' });
    expect((file.scenes as { start: number; duration: number }[]).map((scene) => [scene.start, scene.duration])).toEqual([
      [0, 3],
      [3, 4],
      [7, 5],
      [12, 3],
    ]);
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
