/**
 * Public posts' shared rules (lib/domain/post.ts), and that migration 0056
 * copies #158's public Q&A with the very statements the app reruns
 * (public-qa-sync.ts), so a deploy and the hourly cron agree.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { feedTabOf, POST_DETAIL_MAX, POST_QUESTION_MAX, postDay, postInputError, stripMention } from '@/lib/domain/post';
import { SYNC_PUBLIC_QA_STATEMENTS } from '@/lib/services/public-qa-sync';
import { CRAWL_DISALLOWED } from '@/lib/http/private-paths';
import { isLocalizedPath } from '@/i18n/paths';
import { safeReturnTo } from '@/lib/domain/auth';

describe('posts', () => {
  it('reads the feed tab, defaulting to 为你推荐', () => {
    expect(feedTabOf('latest')).toBe('latest');
    expect(feedTabOf('unanswered')).toBe('unanswered');
    expect(feedTabOf('nope')).toBe('for_you');
    expect(feedTabOf(undefined)).toBe('for_you');
  });

  it('counts free posts by the UTC day', () => {
    expect(postDay(new Date('2026-11-18T23:59:00-08:00'))).toBe('2026-11-19');
  });

  it('checks a post fits', () => {
    expect(postInputError('  ', '')).toBe('empty');
    expect(postInputError('x'.repeat(POST_QUESTION_MAX + 1), '')).toBe('too_long');
    expect(postInputError('ok?', 'x'.repeat(POST_DETAIL_MAX + 1))).toBe('too_long');
    expect(postInputError('ok?', '')).toBeNull();
  });

  it('drops an @mention of the named Ree from the question', () => {
    expect(stripMention('@Brazil Guide what about visas?', 'Brazil Guide')).toBe('what about visas?');
    expect(stripMention('visas? @Brazil Guide', 'Brazil Guide')).toBe('visas?');
    expect(stripMention('email me@Brazil Guide', 'Brazil Guide')).toBe('email me@Brazil Guide');
  });

  it('copies the public Q&A in migration 0056 with the statements the cron reruns', () => {
    const migration = readFileSync('db/migrations/0056_public_posts.sql', 'utf8');
    for (const statement of SYNC_PUBLIC_QA_STATEMENTS) expect(migration).toContain(statement);
    /* Each statement is its own autocommitted step: nothing that needs one transaction. */
    expect(migration).not.toMatch(/\bBEGIN\b|ON COMMIT DROP/i);
  });

  it('gives post pages per-language URLs and leaves them to search engines', () => {
    expect(isLocalizedPath('/p/0b9c6c2e-8c43-4a43-9f5a-8d8a2d3c1f00')).toBe(true);
    expect(isLocalizedPath('/p/x/opengraph-image')).toBe(false);
    expect(CRAWL_DISALLOWED.some((path) => '/p/0b9c6c2e-8c43-4a43-9f5a-8d8a2d3c1f00'.startsWith(path))).toBe(false);
    /* Signing in to vote or save comes back to the post. */
    expect(safeReturnTo('/zh/p/0b9c6c2e-8c43-4a43-9f5a-8d8a2d3c1f00')).toBe('/zh/p/0b9c6c2e-8c43-4a43-9f5a-8d8a2d3c1f00');
  });
});
