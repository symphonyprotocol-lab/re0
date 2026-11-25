import { describe, expect, it } from 'vitest';
import {
  billableBytes,
  byteWindow,
  cleanClientName,
  clientLabel,
  coalesces,
  globToRegex,
  lineCount,
  lineWindow,
  normalizePath,
  relativeToRoot,
  restoredName,
  underRoot,
} from '@/lib/domain/workspace';

describe('workspace paths', () => {
  it('normalizes what agents write and refuses what could escape or confuse', () => {
    expect(normalizePath('notes//a.md/')).toBe('/notes/a.md');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('Café.md')).toBe('/Café.md');
    for (const bad of ['', '/a/../b', './a', 'a\\b', 'a\u0000b', '/a/ b /c', 42, null]) expect(normalizePath(bad)).toBeNull();
    expect(normalizePath(`/${'x'.repeat(256)}`)).toBeNull();
    expect(normalizePath(`/${'x'.repeat(255)}`)).not.toBeNull();
  });

  it('treats a key root as its "/"', () => {
    expect(underRoot('/projects/a', '/notes.md')).toBe('/projects/a/notes.md');
    expect(underRoot('/projects/a', '/')).toBe('/projects/a');
    expect(relativeToRoot('/projects/a', '/Projects/A/notes.md')).toBe('/notes.md');
    expect(relativeToRoot('/projects/a', '/projects/ab/x')).toBeNull();
    expect(relativeToRoot('/', '/x')).toBe('/x');
  });

  it('turns globs into anchored expressions', () => {
    const match = (glob: string, path: string) => new RegExp(globToRegex(glob)).test(path);
    expect(match('*.md', 'a.md')).toBe(true);
    expect(match('*.md', 'docs/a.md')).toBe(false);
    expect(match('**/*.md', 'a.md')).toBe(true);
    expect(match('**/*.md', 'docs/x/a.md')).toBe(true);
    expect(match('docs/?.csv', 'docs/a.csv')).toBe(true);
    expect(match('a+b.(md)', 'a+b.(md)')).toBe(true);
  });

  it('names a restored path that is free', () => {
    const taken = new Set(['/a/plan (restored).md']);
    expect(restoredName('/a/plan.md', (path) => taken.has(path))).toBe('/a/plan (restored 2).md');
    expect(restoredName('/proj', () => false)).toBe('/proj (restored)');
  });
});

describe('workspace reads', () => {
  it('windows lines, keeping the final newline only at the end', () => {
    const text = 'a\nb\nc\n';
    expect(lineCount(text)).toBe(3);
    expect(lineWindow(text, { maxBytes: 100 })).toMatchObject({ content: text, truncated: false, totalLines: 3 });
    expect(lineWindow(text, { offset: 2, limit: 1, maxBytes: 100 })).toMatchObject({ content: 'b', startLine: 2, endLine: 2, nextOffset: 3 });
    expect(lineWindow('x'.repeat(10) + '\nyy', { maxBytes: 5 })).toMatchObject({ endLine: 1, truncated: true, nextOffset: 2 });
    expect(lineWindow('', { maxBytes: 5 })).toMatchObject({ content: '', totalLines: 0, truncated: false });
  });

  it('windows bytes on whole characters', () => {
    /* A start inside a character moves to the next one; the length counts from there, and never ends inside one. */
    expect(byteWindow('中文ab', 1, 4)).toMatchObject({ content: '文a', nextOffset: 7 });
    expect(byteWindow('中文ab', 0, 4)).toMatchObject({ content: '中', nextOffset: 3 });
  });
});

describe('workspace versions and storage', () => {
  const at = (seconds: number) => new Date(Date.UTC(2031, 0, 1, 0, 0, seconds));
  const latest = { apiKeyId: 'k', userId: 'u', updatedAt: at(0), op: 'write' };
  it('merges the same key’s saves within the window only', () => {
    expect(coalesces(latest, { apiKeyId: 'k', userId: 'u', op: 'edit' }, at(59), 60_000)).toBe(true);
    expect(coalesces(latest, { apiKeyId: 'k', userId: 'u', op: 'edit' }, at(60), 60_000)).toBe(false);
    expect(coalesces(latest, { apiKeyId: 'other', userId: 'u', op: 'write' }, at(1), 60_000)).toBe(false);
    expect(coalesces(latest, { apiKeyId: 'k', userId: 'u', op: 'restore' }, at(1), 60_000)).toBe(false);
    expect(coalesces({ ...latest, apiKeyId: null }, { apiKeyId: null, userId: 'u', op: 'write' }, at(1), 60_000)).toBe(true);
    expect(coalesces(null, { apiKeyId: 'k', userId: 'u', op: 'write' }, at(1), 60_000)).toBe(false);
  });

  it('applies the free allowance to Blob bytes first', () => {
    expect(billableBytes(50n, 30n, 100n)).toEqual({ blob: 0n, database: 0n });
    expect(billableBytes(150n, 30n, 100n)).toEqual({ blob: 50n, database: 30n });
    expect(billableBytes(80n, 30n, 100n)).toEqual({ blob: 0n, database: 10n });
  });

  it('cleans and labels client names', () => {
    expect(cleanClientName('claude-code')).toBe('claude-code');
    expect(cleanClientName('<script>x</script>')).toBe('scriptx/script');
    expect(cleanClientName(12)).toBeNull();
    expect(clientLabel('claude-code')).toBe('Claude Code');
    expect(clientLabel('codex-mcp-client')).toBe('Codex');
    expect(clientLabel('my-agent')).toBe('my-agent');
  });
});
