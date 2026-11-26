import { describe, expect, it } from 'vitest';
import {
  binaryByName,
  decodeText,
  diffLines,
  indexableFormat,
  mediaTypeOf,
  partCount,
  partLength,
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

describe('bytes in the workspace (third phase)', () => {
  it('keeps text exactly as text, and anything else as bytes', () => {
    expect(decodeText(new TextEncoder().encode('\ufeffhéllo\r\n'))).toBe('\ufeffhéllo\r\n');
    expect(decodeText(new Uint8Array([0x68, 0x00, 0x69]))).toBeNull();
    expect(decodeText(new Uint8Array([0xc3, 0x28]))).toBeNull();
    expect(binaryByName('/a/report.PDF')).toBe(true);
    expect(binaryByName('/a/notes.md')).toBe(false);
    expect(binaryByName('/a/README')).toBe(false);
  });

  it('types downloads from the name and knows what the index can read', () => {
    expect(mediaTypeOf('/x.pdf', { binary: true })).toBe('application/pdf');
    expect(mediaTypeOf('/x.unknown', { binary: true })).toBe('application/octet-stream');
    expect(mediaTypeOf('/x.json', { binary: true })).toBe('application/json');
    expect(indexableFormat('/x.pdf', 'application/pdf')).toBe('pdf');
    expect(indexableFormat('/x.docx', null)).toBe('docx');
    expect(indexableFormat('/big.md', 'text/markdown')).toBe('text');
    expect(indexableFormat('/p.png', 'image/png')).toBeNull();
  });

  it('cuts an upload into parts of exactly the part size, the last one smaller', () => {
    expect(partCount(0, 4)).toBe(1);
    expect(partCount(8, 4)).toBe(2);
    expect(partCount(9, 4)).toBe(3);
    expect([1, 2, 3].map((n) => partLength(9, 4, n))).toEqual([4, 4, 1]);
    expect(partLength(9, 4, 4)).toBe(-1);
    expect(partLength(9, 4, 0)).toBe(-1);
    expect(partLength(0, 4, 1)).toBe(0);
  });

  it('compares versions by lines, both sides recoverable, and gives up past the edit limit', () => {
    const lines = diffLines('a\nb\nc\nd', 'a\nx\nc\nd\ne')!;
    expect(lines.map((line) => `${line.kind[0]}${line.old ?? '-'}${line.new ?? '-'}${line.text}`)).toEqual(['s11a', 'r2-b', 'a-2x', 's33c', 's44d', 'a-5e']);
    for (let round = 0; round < 300; round += 1) {
      const random = () => Array.from({ length: Math.floor(Math.random() * 10) }, () => 'xyz'[Math.floor(Math.random() * 3)]).join('\n');
      const [a, b] = [random(), random()];
      const diff = diffLines(a, b)!;
      expect(diff.filter((line) => line.kind !== 'added').map((line) => line.text).join('\n')).toBe(a);
      expect(diff.filter((line) => line.kind !== 'removed').map((line) => line.text).join('\n')).toBe(b);
    }
    expect(diffLines(Array.from({ length: 50 }, (_, i) => `a${i}`).join('\n'), Array.from({ length: 50 }, (_, i) => `b${i}`).join('\n'), 10)).toBeNull();
  });

  it('stays small and quick on two large, heavily rewritten files, and gives up past the line limit', () => {
    const lines = (seed: string, n: number) => Array.from({ length: n }, (_, i) => `${seed}${i % 7}`).join('\n');
    const started = Date.now();
    expect(diffLines(lines('a', 19_000), lines('b', 19_000))).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(diffLines(lines('a', 30_000), lines('a', 30_000) + '\nmore')).toBeNull();
    expect(diffLines(lines('a', 1_000), `${lines('a', 1_000)}\nmore`)!.filter((line) => line.kind === 'added')).toHaveLength(1);
  });
});
