import { describe, expect, it } from 'vitest';
import {
  chunkFile,
  effectiveIndexMode,
  excludedBy,
  fileNameForTitle,
  scanSecrets,
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
  restoredCandidate,
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

  it('names the candidates for a restored path', () => {
    expect(restoredCandidate('/a/plan.md', 1)).toBe('/a/plan (restored).md');
    expect(restoredCandidate('/a/plan.md', 2)).toBe('/a/plan (restored 2).md');
    expect(restoredCandidate('/proj', 1)).toBe('/proj (restored)');
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
  const latest = { apiKeyId: 'k', userId: 'u', runStartedAt: at(0), op: 'write' };
  it('merges the same key’s saves within a window anchored at the run start', () => {
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

describe('workspace passages', () => {
  const estimate = (line: string) => Math.ceil(line.length / 4);
  it('cuts at content-defined lines, so an edit leaves far-away passages as they were', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${'words '.repeat(8)}`);
    const before = chunkFile('a.txt', lines.join('\n'), { estimate });
    const edited = [...lines];
    edited[200] = 'changed';
    const after = chunkFile('a.txt', edited.join('\n'), { estimate });
    const old = new Set(before.map((passage) => passage.content));
    expect(after.filter((passage) => !old.has(passage.content)).length).toBeLessThanOrEqual(3);
    expect(before[0]!.locator).toEqual({ path: 'a.txt', line: 1 });
  });

  it('starts a passage at each Markdown heading and remembers it', () => {
    const passages = chunkFile('n.md', '# Top\nintro\n## Sub\nbody', { estimate });
    expect(passages.map((passage) => [passage.locator.line, passage.locator.heading])).toEqual([[1, 'Top'], [3, 'Top › Sub']]);
  });

  it('finds secrets in their usual shapes', () => {
    expect(scanSecrets(`token re0_sk_${'a'.repeat(64)}`)).toBe('re0_api_key');
    expect(scanSecrets('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe('private_key');
    expect(scanSecrets('AKIAABCDEFGHIJKLMNOP')).toBe('aws_access_key');
    expect(scanSecrets('the word skeleton and sk-short')).toBeNull();
  });

  it('inherits index modes from the nearest folder that sets one', () => {
    const modes = new Map([['/a', 'on'], ['/a/b', 'off']]);
    expect(effectiveIndexMode('/a/x.md', modes)).toBe('on');
    expect(effectiveIndexMode('/a/b/y.md', modes)).toBe('off');
    expect(effectiveIndexMode('/c/z.md', modes)).toBe('off');
    expect(effectiveIndexMode('/a/b/y.md', new Map([...modes, ['/a/b/y.md', 'on']]))).toBe('on');
  });

  it('applies binding excludes by name or by path', () => {
    expect(excludedBy(['**/*.log'], 'logs/run.log')).toBe(true);
    expect(excludedBy(['drafts/**'], 'drafts/a.md')).toBe(true);
    expect(excludedBy(['drafts/**'], 'final/a.md')).toBe(false);
    expect(excludedBy(['*.tmp'], 'deep/x.tmp')).toBe(true);
  });

  it('makes a file name from a title', () => {
    expect(fileNameForTitle('Packing / list')).toBe('Packing - list.md');
    expect(fileNameForTitle('notes.md')).toBe('notes.md');
    expect(fileNameForTitle('   ')).toBe('untitled.md');
  });
});
