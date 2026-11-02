/** The wizard and settings rules, from rebuild-prototype/tests/dot-setup.test.mjs. */
import { describe, expect, it } from 'vitest';
import { pageNumbers } from '@/lib/domain/list';
import { classification, coerceDraft, newReeDraft, reeValues, validateDraftSource, validateReeFields, visibilityPlan } from '@/lib/domain/ree';

const complete = () => ({
  ...newReeDraft(),
  name: '研究助手',
  description: '整理我的研究资料',
  category: 'learning' as const,
  tags: ['科学研究', '自定义标签'],
  systemPrompt: '分步骤作答，并注明来源',
  sampleQuestions: '总结关键观点\n有哪些依据？',
  isPublic: true,
  queryFee: 25,
  color: 'sage' as const,
});

describe('validateReeFields', () => {
  it('validates identity, classification, questions and price step by step', () => {
    const draft = newReeDraft();
    expect(validateReeFields(draft, 1)).toEqual({ step: 1, error: 'name' });
    draft.name = 'Ree';
    expect(validateReeFields(draft, 1)).toBeNull();
    expect(validateReeFields(draft, 2)).toEqual({ step: 2, error: 'category' });
    expect(validateReeFields(complete(), 4)).toBeNull();
    expect(validateReeFields({ ...complete(), sampleQuestions: '1\n2\n3\n4' }, 4)?.error).toBe('samples');
    expect(validateReeFields({ ...complete(), sampleQuestions: 'x'.repeat(161) }, 4)?.error).toBe('samples');
    expect(validateReeFields({ ...complete(), queryFee: 10001 }, 4)?.error).toBe('fee');
    expect(validateReeFields({ ...complete(), queryFee: 1.5 }, 4)?.error).toBe('fee');
    expect(validateReeFields({ ...complete(), name: 'n'.repeat(41) }, 1)?.error).toBe('name');
    expect(validateReeFields({ ...complete(), description: 'd'.repeat(241) }, 1)?.error).toBe('description');
    expect(validateReeFields({ ...complete(), systemPrompt: 'p'.repeat(4001) }, 2)?.error).toBe('prompt');
  });

  it('keeps every setup detail when the Ree is written', () => {
    const values = reeValues(complete());
    expect(values).toMatchObject({
      name: '研究助手',
      category: 'learning',
      tags: ['科学研究', '自定义标签'],
      systemPrompt: '分步骤作答，并注明来源',
      sampleQuestions: ['总结关键观点', '有哪些依据？'],
      isPublic: true,
      queryFee: 25,
      color: 'sage',
    });
  });
});

describe('classification', () => {
  it('normalizes, de-duplicates case-insensitively and caps tags', () => {
    expect(classification('design', ['  React ', 'react', 'UX'])).toEqual({ category: 'design', tags: ['React', 'UX'] });
    expect(classification('design', ['a', 'b', 'c', 'd'])).toEqual({ error: 'limit' });
    expect(classification('design', ['x'.repeat(21)])).toEqual({ error: 'length' });
    expect(classification('', [])).toEqual({ error: 'category' });
  });
});

describe('draft', () => {
  it('requires an uploaded document or a complete text source', () => {
    const source = newReeDraft().source;
    expect(validateDraftSource(source)).toBeNull();
    expect(validateDraftSource({ ...source, kind: 'document' })).toBe('file');
    expect(validateDraftSource({ ...source, kind: 'text', title: 't', text: '' })).toBe('source-text');
    expect(validateDraftSource({ ...source, kind: 'text', title: 't', text: 'x'.repeat(30001) })).toBe('source-text');
    expect(validateDraftSource({ ...source, kind: 'text', title: 't', text: 'body' })).toBeNull();
  });

  it('opens all six kinds in step 3, each with its own check', () => {
    const source = newReeDraft().source;
    expect(validateDraftSource({ ...source, kind: 'audio' })).toBe('file');
    expect(validateDraftSource({ ...source, kind: 'audio', blobPath: 'knowledge/u/1/a.mp3' })).toBe('audio-consent');
    expect(validateDraftSource({ ...source, kind: 'audio', blobPath: 'knowledge/u/1/a.mp3', consent: true })).toBeNull();
    expect(validateDraftSource({ ...source, kind: 'github', url: 'https://example.com/acme/x' })).toBe('github-url');
    expect(validateDraftSource({ ...source, kind: 'github', url: 'https://github.com/acme/x' })).toBeNull();
    expect(validateDraftSource({ ...source, kind: 'page', url: 'not a url' })).toBe('url');
    expect(validateDraftSource({ ...source, kind: 'site', url: 'http://localhost/docs' })).toBe('url');
    expect(validateDraftSource({ ...source, kind: 'site', url: 'https://docs.example.com/' })).toBeNull();
  });

  it('coerces whatever arrives and never lets a step pass the furthest reached', () => {
    const draft = coerceDraft({ name: 'x', step: 4, reached: 2, color: 'neon', source: { kind: 'video', blobPath: '../etc', consent: 'yes' } });
    expect(draft.step).toBe(2);
    expect(draft.color).toBe('default');
    expect(draft.source.kind).toBe('later');
    expect(draft.source.blobPath).toBe('');
    expect(draft.source.consent).toBe(false);
    expect(coerceDraft({ source: { kind: 'github', url: 'https://github.com/a/b' } }).source).toMatchObject({ kind: 'github', url: 'https://github.com/a/b' });
  });
});

describe('visibilityPlan (prototype ownedReeVisibilityPlan)', () => {
  const rows = [
    { id: 'pub', isPublic: true, moderated: false },
    { id: 'priv', isPublic: false, moderated: false },
    { id: 'down', isPublic: false, moderated: true },
  ];
  it('changes only what differs, skips taken-down Rees going public, reports unknown ids', () => {
    expect(visibilityPlan(rows, ['pub', 'priv', 'down', 'gone', 'priv'], true)).toEqual({ changes: ['priv'], unchanged: ['pub'], blocked: ['down'], missing: ['gone'] });
    expect(visibilityPlan(rows, ['pub', 'priv', 'down'], false)).toEqual({ changes: ['pub'], unchanged: ['priv', 'down'], blocked: [], missing: [] });
  });
});

describe('pageNumbers (prototype discoveryPageNumbers)', () => {
  it('keeps the first, last and neighbours, with gaps as null', () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(1, 3)).toEqual([1, 2, 3]);
    expect(pageNumbers(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageNumbers(10, 10)).toEqual([1, null, 9, 10]);
  });
});
