import { describe, expect, it } from 'vitest';
import { channelOf, classifySource, isBotAgent, referrerHost, TRAFFIC_VISIT_SECONDS, trackedPath, utmValue, visitOf } from '@/lib/domain/traffic';

const OWN = ['re0.io', 'localhost'];
const source = (referrer: string, utmSource?: string) => classifySource({ referrer, utmSource, ownHosts: OWN });

describe('traffic: the page a beacon reports (trackedPath)', () => {
  it('drops the query and hash and names the page kind', () => {
    expect(trackedPath('/')).toEqual({ path: '/', kind: 'home' });
    expect(trackedPath('/?utm_source=twitter#top')).toEqual({ path: '/', kind: 'home' });
    expect(trackedPath('/r/Some-Ree?from=%2Fexplore')).toEqual({ path: '/r/some-ree', kind: 'ree' });
    expect(trackedPath('/s/Some-Ree')).toEqual({ path: '/s/some-ree', kind: 'share' });
    expect(trackedPath('/p/0c8f4f43-1f0a-4cf5-9f44-8a4c7bd5e222')).toEqual({ path: '/p/0c8f4f43-1f0a-4cf5-9f44-8a4c7bd5e222', kind: 'post' });
    expect(trackedPath('/explore?category=tech')).toEqual({ path: '/explore', kind: 'explore' });
    expect(trackedPath('/pricing')).toEqual({ path: '/pricing', kind: 'pricing' });
    expect(trackedPath('/about')?.kind).toBe('about');
    expect(trackedPath('/legal/terms')?.kind).toBe('legal');
    expect(trackedPath('/login?returnTo=%2Frees')).toEqual({ path: '/login', kind: 'login' });
    expect(trackedPath('/rees/abc/settings')?.kind).toBe('workspace');
    expect(trackedPath('/dashboard')?.kind).toBe('workspace');
    expect(trackedPath('/something-else')?.kind).toBe('other');
    expect(trackedPath('/r/x/opengraph-image')?.kind).toBe('other');
  });

  it('counts the language variants of a localized page as one page', () => {
    expect(trackedPath('/en')).toEqual({ path: '/', kind: 'home' });
    expect(trackedPath('/zh/')).toEqual({ path: '/', kind: 'home' });
    expect(trackedPath('/en/pricing')).toEqual({ path: '/pricing', kind: 'pricing' });
    expect(trackedPath('/zh/r/Some-Ree')).toEqual({ path: '/r/some-ree', kind: 'ree' });
    expect(trackedPath('/en/explore?q=a')).toEqual({ path: '/explore', kind: 'explore' });
    // Only localized pages have a prefix; anything else keeps its path.
    expect(trackedPath('/en/rees')).toEqual({ path: '/en/rees', kind: 'other' });
  });

  it('normalises slashes', () => {
    expect(trackedPath('/pricing/')).toEqual({ path: '/pricing', kind: 'pricing' });
    expect(trackedPath('/r//x')).toEqual({ path: '/r/x', kind: 'ree' });
  });

  it('never counts the console, API routes or what is not a path', () => {
    for (const path of ['/admin', '/admin/overview', '/admin/login?next=1', '/ADMIN/users', '/api/track/view', '/_next/static/x.js', '/media/a', '/en/admin']) {
      // `/en/admin` is not a localized page, so it is not the console either: it is an unknown page.
      if (path === '/en/admin') expect(trackedPath(path)?.kind).toBe('other');
      else expect(trackedPath(path)).toBeNull();
    }
    for (const raw of [undefined, null, 42, '', 'pricing', 'https://re0.io/', '//evil.example/', `/${'a'.repeat(400)}`, '/a b', '/a\\b']) expect(trackedPath(raw)).toBeNull();
  });
});

describe('traffic: where a visit came from (classifySource)', () => {
  it('names Twitter / X, whichever host or app sent the visitor', () => {
    for (const referrer of ['https://t.co/abc123', 'https://twitter.com/someone/status/1', 'https://x.com/', 'https://mobile.twitter.com/', 'https://mobile.x.com/home', 'android-app://com.twitter.android']) {
      expect(source(referrer)).toMatchObject({ source: 'twitter', channel: 'social' });
    }
  });

  it('names search engines and other known sites', () => {
    expect(source('https://www.google.com/')).toMatchObject({ source: 'google', channel: 'search', referrerHost: 'www.google.com' });
    expect(source('https://www.google.co.jp/')).toMatchObject({ source: 'google', channel: 'search' });
    expect(source('https://www.bing.com/search?q=re0')).toMatchObject({ source: 'bing', channel: 'search' });
    expect(source('https://duckduckgo.com/')).toMatchObject({ source: 'duckduckgo' });
    expect(source('https://github.com/symphonyprotocol-lab')).toMatchObject({ source: 'github', channel: 'referral' });
    expect(source('https://news.ycombinator.com/item?id=1')).toMatchObject({ source: 'hackernews', channel: 'social' });
    expect(source('https://www.reddit.com/r/x')).toMatchObject({ source: 'reddit', channel: 'social' });
    // Only the host is ever kept, never the path or query.
    expect(source('https://www.google.com/search?q=private').referrerHost).toBe('www.google.com');
  });

  it('is direct without a referrer, internal from this site, a referral by host otherwise', () => {
    expect(source('')).toEqual({ source: 'direct', channel: 'direct', referrerHost: null });
    expect(source('not a url')).toEqual({ source: 'direct', channel: 'direct', referrerHost: null });
    expect(classifySource({ ownHosts: OWN })).toEqual({ source: 'direct', channel: 'direct', referrerHost: null });
    expect(source('https://re0.io/explore')).toEqual({ source: 'internal', channel: 'internal', referrerHost: 're0.io' });
    expect(source('http://localhost:3000/pricing')).toMatchObject({ source: 'internal' });
    expect(source('https://www.example.com/blog/post')).toEqual({ source: 'example.com', channel: 'referral', referrerHost: 'www.example.com' });
    expect(source('https://news.example.org/')).toMatchObject({ source: 'news.example.org', channel: 'referral' });
    // google-looking hosts that are not Google stay referrals.
    expect(source('https://notgoogle.com/')).toMatchObject({ source: 'notgoogle.com', channel: 'referral' });
    // Other schemes are not referrers.
    expect(source('javascript:alert(1)')).toMatchObject({ source: 'direct' });
  });

  it('lets utm_source win over the referrer, with known aliases', () => {
    expect(source('', 'twitter')).toMatchObject({ source: 'twitter', channel: 'social' });
    expect(source('', 'X')).toMatchObject({ source: 'twitter', channel: 'social' });
    expect(source('https://www.google.com/', 'twitter')).toMatchObject({ source: 'twitter', referrerHost: 'www.google.com' });
    expect(source('https://re0.io/', 'newsletter')).toEqual({ source: 'newsletter', channel: 'campaign', referrerHost: 're0.io' });
    expect(source('', 'google')).toMatchObject({ source: 'google', channel: 'search' });
    expect(source('', '  ')).toMatchObject({ source: 'direct' });
    expect(source('', 'x'.repeat(300)).source).toHaveLength(100);
  });

  it('gives each stored label its class', () => {
    expect(channelOf('direct')).toBe('direct');
    expect(channelOf('internal')).toBe('internal');
    expect(channelOf('twitter')).toBe('social');
    expect(channelOf('google')).toBe('search');
    expect(channelOf('example.com')).toBe('referral');
    expect(channelOf('newsletter')).toBe('campaign');
  });

  it('reads hosts and utm values carefully', () => {
    expect(referrerHost('https://T.CO/x')).toBe('t.co');
    expect(referrerHost(42)).toBeNull();
    expect(utmValue('  Launch Week ')).toBe('Launch Week');
    expect(utmValue('Twitter', true)).toBe('twitter');
    expect(utmValue(['a'])).toBeNull();
  });
});

describe('traffic: visits and landing pages (visitOf)', () => {
  const arrived = source('https://t.co/abc');
  const now = new Date('2026-11-20T10:00:00Z');
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1_000);

  it('lands a first view, with the source it arrived from', () => {
    expect(visitOf(null, arrived, now)).toEqual({ landing: true, source: 'twitter' });
  });

  it('keeps later views in the open visit, inheriting its source', () => {
    expect(visitOf({ at: ago(60), source: 'google' }, arrived, now)).toEqual({ landing: false, source: 'google' });
    expect(visitOf({ at: ago(TRAFFIC_VISIT_SECONDS), source: 'google' }, source('https://re0.io/'), now)).toEqual({ landing: false, source: 'google' });
  });

  it('starts a new visit after half an hour without a view', () => {
    expect(visitOf({ at: ago(TRAFFIC_VISIT_SECONDS + 1), source: 'google' }, arrived, now)).toEqual({ landing: true, source: 'twitter' });
    expect(visitOf({ at: ago(TRAFFIC_VISIT_SECONDS + 1), source: 'google' }, source('https://re0.io/explore'), now)).toEqual({ landing: true, source: 'internal' });
  });
});

describe('traffic: bots', () => {
  it('knows crawlers, preview fetchers and HTTP libraries', () => {
    for (const agent of [
      'Twitterbot/1.0',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
      'curl/8.4.0',
      'python-requests/2.31.0',
      'node-fetch/1.0',
      '',
      null,
    ]) expect(isBotAgent(agent)).toBe(true);
  });

  it('lets browsers through', () => {
    for (const agent of [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/10.70',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    ]) expect(isBotAgent(agent)).toBe(false);
  });
});
