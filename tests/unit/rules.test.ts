import { describe, expect, it } from 'vitest';
import { safeReturnTo } from '@/lib/domain/auth';
import { AUDIT_ACTIONS } from '@/lib/domain/audit';
import { clampPage, likePattern, parseList } from '@/lib/domain/list';
import { changesWhatAnswers, mayCarryKey, parseModelConfig } from '@/lib/domain/models';

describe('list contract (8.1)', () => {
  it('parses q/status/sort/size/page and pulls an out-of-range page back', () => {
    const query = parseList(new URLSearchParams('q= hi &status=public&sort=bogus&size=24&page=0'), {
      statuses: ['all', 'public', 'private'],
      sorts: ['default', 'name_asc'],
      sizes: [12, 24, 48],
    });
    expect(query).toEqual({ q: 'hi', status: 'public', sort: 'default', size: 24, page: 1 });
    expect(clampPage(9, 30, 12)).toBe(3);
    expect(clampPage(2, 0, 12)).toBe(1);
    expect(likePattern('50%_')).toBe('%50\\%\\_%');
  });
});

describe('sign-in return path', () => {
  it('only returns into the app', () => {
    expect(safeReturnTo('/rees/abc/chat')).toBe('/rees/abc/chat');
    expect(safeReturnTo('//evil.example')).toBe('/rees');
    expect(safeReturnTo('https://evil.example')).toBe('/rees');
    expect(safeReturnTo('/admin/models')).toBe('/rees');
  });

  it('returns to every gated workspace page (prototype experience.js safeNext)', () => {
    expect(safeReturnTo('/videos')).toBe('/videos');
    expect(safeReturnTo('/workspace/answers?view=records&period=week')).toBe('/workspace/answers?view=records&period=week');
  });
});

describe('model configuration (2.5)', () => {
  it('validates entries', () => {
    expect(parseModelConfig({ name: 'g', kind: 'generation', transport: 'gateway', model: 'openai/gpt-5-mini' })).toMatchObject({ model: 'openai/gpt-5-mini', baseUrl: null });
    expect(parseModelConfig({ name: 'g', kind: 'generation', transport: 'gateway', model: 'gpt-5-mini' })).toEqual({ error: 'model' });
    expect(parseModelConfig({ name: 'g', kind: 'generation', transport: 'openai_compatible', baseUrl: 'ftp://x', model: 'm' })).toEqual({ error: 'base_url' });
    expect(parseModelConfig({ name: 'g', kind: 'chat', transport: 'gateway', model: 'a/b' })).toEqual({ error: 'kind' });
    expect(parseModelConfig({ name: 'g', kind: 'generation', transport: 'gateway', model: 'a/b', timeoutMs: 500 })).toEqual({ error: 'timeout' });
  });

  it('freezes what answers and keeps keys on their origin', () => {
    const live = { transport: 'openai_compatible' as const, baseUrl: 'https://a.example/v1', model: 'm1' };
    expect(changesWhatAnswers(live, { ...live })).toBe(false);
    expect(changesWhatAnswers(live, { ...live, model: 'm2' })).toBe(true);
    expect(mayCarryKey(live, { transport: 'openai_compatible', baseUrl: 'https://a.example/v2' })).toBe(true);
    expect(mayCarryKey(live, { transport: 'openai_compatible', baseUrl: 'https://evil.example/v1' })).toBe(false);
  });

  it('has one list of audit codes', () => {
    expect(AUDIT_ACTIONS).toContain('model.activate');
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });
});
