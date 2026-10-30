/**
 * The file list of a PDF asset after an edit. The rule is pure so the
 * dashboard's save and a test agree on what an edit may do: drop only files
 * the source lists, add only files it does not, and never exceed the ceiling.
 */
import { describe, expect, it } from 'vitest';
import { mergeUploadedFiles, UPLOAD_LIMITS, type UploadedFile } from '@/lib/domain/asset';

const file = (id: string): UploadedFile => ({ id, name: `${id}.pdf`, size: 1, key: `uploads/ws/b/${id}.pdf` });

describe('mergeUploadedFiles', () => {
  it('removes listed ids and appends the additions, in order', () => {
    const merged = mergeUploadedFiles([file('a'), file('b'), file('c')], [file('d')], ['b']);
    expect(merged?.map((entry) => entry.id)).toEqual(['a', 'c', 'd']);
  });

  it('refuses a removal of a file the source does not list, or listed twice', () => {
    expect(mergeUploadedFiles([file('a')], [], ['zzz'])).toBeNull();
    expect(mergeUploadedFiles([file('a')], [], ['a', 'a'])).toBeNull();
  });

  it('refuses an addition the source already lists', () => {
    expect(mergeUploadedFiles([file('a')], [file('a')], [])).toBeNull();
  });

  it('may empty the list, and holds the ceiling across the edit', () => {
    expect(mergeUploadedFiles([file('a')], [], ['a'])).toEqual([]);
    const full = Array.from({ length: UPLOAD_LIMITS.maxFiles }, (_, i) => file(`f${i}`));
    expect(mergeUploadedFiles(full, [file('one-more')], [])).toBeNull();
    expect(mergeUploadedFiles(full, [file('one-more')], ['f0'])).toHaveLength(UPLOAD_LIMITS.maxFiles);
  });
});
