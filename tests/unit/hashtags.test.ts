import { describe, expect, it } from 'vitest';
import { channelHref, channelNameOf, extractHashtags, hashtagSegments, HASHTAG_MAX_LENGTH, POST_HASHTAG_MAX } from '@/lib/domain/hashtags';

const tags = (text: string) => extractHashtags(text);

describe('hashtags', () => {
  it('finds latin, CJK, digits, underscores and hyphens', () => {
    expect(tags('Going to Brazil #travel #new_york #sci-fi #k8s')).toEqual(['travel', 'new_york', 'sci-fi', 'k8s']);
    expect(tags('#旅行 日本还是韩国？ #美食')).toEqual(['旅行', '美食']);
    expect(tags('#東京 #서울 #café')).toEqual(['東京', '서울', 'café']);
  });

  it('is case-insensitive and folds full-width forms', () => {
    expect(tags('#Travel #TRAVEL #travel')).toEqual(['travel']);
    expect(tags('＃ＴＲＡＶＥＬ ＃旅行')).toEqual(['travel', '旅行']);
  });

  it('needs a letter, and drops trailing hyphens', () => {
    expect(tags('issue #123 and #2024')).toEqual([]);
    expect(tags('#2024travel')).toEqual(['2024travel']);
    expect(tags('love #travel-, really')).toEqual(['travel']);
    expect(tags('#-travel')).toEqual([]);
  });

  it('starts only at a boundary: not inside words, entities or paths', () => {
    expect(tags('I write C# and F#')).toEqual([]);
    expect(tags('a#b &#123; path/#x')).toEqual([]);
    expect(tags('我想去日本#旅行')).toEqual([]);
    expect(tags('(#travel) “#旅行”，#美食。')).toEqual(['travel', '旅行', '美食']);
    expect(tags('#a#b')).toEqual([]);
  });

  it('accepts a Weibo-style closing #', () => {
    expect(tags('#旅行# 去哪里好')).toEqual(['旅行']);
    expect(tags('#旅行#美食')).toEqual([]);
  });

  it('skips URLs, inline code and markdown headings', () => {
    expect(tags('see https://example.com/page#section and www.x.com/#top')).toEqual([]);
    expect(tags('# Heading\n## Sub heading\n#real')).toEqual(['real']);
    expect(tags('run `git log #oops` then #git')).toEqual(['git']);
  });

  it('caps the length: a longer run is not a tag', () => {
    const max = 'a'.repeat(HASHTAG_MAX_LENGTH);
    expect(tags(`#${max}`)).toEqual([max]);
    expect(tags(`#${max}a`)).toEqual([]);
    expect(tags(`#${'旅'.repeat(HASHTAG_MAX_LENGTH)}`)).toHaveLength(1);
  });

  it('keeps the first POST_HASHTAG_MAX distinct tags, question first', () => {
    const many = Array.from({ length: 15 }, (_, i) => `#t${i}`).join(' ');
    expect(extractHashtags(many)).toHaveLength(POST_HASHTAG_MAX);
    expect(extractHashtags('#b #a', '#a #c', null, undefined)).toEqual(['b', 'a', 'c']);
  });

  it('segments round-trip the text', () => {
    const text = 'Plan: #Travel to 日本 #旅行# see https://x.com/#a, `#code` #end';
    const segments = hashtagSegments(text);
    expect(segments.map((s) => (s.kind === 'tag' ? s.raw : s.text)).join('')).toBe(text);
    expect(segments.filter((s) => s.kind === 'tag').map((s) => s.kind === 'tag' && s.name)).toEqual(['travel', '旅行', 'end']);
    expect(hashtagSegments('')).toEqual([]);
  });

  it('normalises names from URLs and builds hrefs', () => {
    expect(channelNameOf('Travel')).toBe('travel');
    expect(channelNameOf('#旅行')).toBe('旅行');
    expect(channelNameOf('')).toBeNull();
    expect(channelNameOf('a b')).toBeNull();
    expect(channelNameOf('123')).toBeNull();
    expect(channelHref('旅行')).toBe('/c/%E6%97%85%E8%A1%8C');
  });
});
