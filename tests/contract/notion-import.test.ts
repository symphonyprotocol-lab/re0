/**
 * The import rule for Notion pages (lib/domain/notion.ts): a page is named
 * by the id at the end of its URL, the connect handshake is its own shape,
 * and the callback lands only on in-app paths with a coarse outcome.
 */
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

import { describe, expect, it } from 'vitest';
import {
  isNotionConnectHandshake,
  isNotionConnectOutcome,
  NOTION_SOURCE_USER_KEY,
  notionPageId,
  notionSourceUserId,
} from '@/lib/domain/notion';
import { notionConnectReturnPath } from '@/lib/application/auth/notion-connection';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';

const ID = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d';
const DASHED = '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';

describe('notionPageId', () => {
  it('reads the id off the end of a titled page URL, whatever the title contains', () => {
    expect(notionPageId(`https://www.notion.so/acme/My-page-with-dashes-${ID}`)).toBe(DASHED);
    expect(notionPageId(`https://acme.notion.site/${ID}`)).toBe(DASHED);
    expect(notionPageId(`https://www.notion.so/${DASHED}?v=abc`)).toBe(DASHED);
    /* The URL the API returns today. */
    expect(notionPageId(`https://app.notion.com/p/Hello-My-Page-${ID}`)).toBe(DASHED);
  });

  it('accepts a bare id, dashed or not', () => {
    expect(notionPageId(ID)).toBe(DASHED);
    expect(notionPageId(DASHED)).toBe(DASHED);
  });

  it('refuses anything that is not a Notion page', () => {
    expect(notionPageId('https://evil.example/' + ID)).toBeNull();
    expect(notionPageId('https://www.notion.so/acme/not-an-id')).toBeNull();
    expect(notionPageId('')).toBeNull();
    expect(notionPageId('not a url')).toBeNull();
  });
});

describe('source config', () => {
  it('names the account a source is read with, and nobody for a platform library', () => {
    expect(notionSourceUserId({ pageId: DASHED, [NOTION_SOURCE_USER_KEY]: 'user-1' })).toBe('user-1');
    expect(notionSourceUserId({ pageId: DASHED })).toBeNull();
    expect(notionSourceUserId(null)).toBeNull();
  });
});

describe('connect handshake and outcome', () => {
  it('recognises only its own handshake shape', () => {
    expect(
      isNotionConnectHandshake({ purpose: 'notion_connect', state: 's', returnTo: '/dashboard', expiresAt: 1 }),
    ).toBe(true);
    /* The GitHub connect handshake must not pass for a Notion one. */
    expect(
      isNotionConnectHandshake({ purpose: 'github_connect', state: 's', returnTo: '/dashboard', expiresAt: 1 }),
    ).toBe(false);
    expect(isNotionConnectHandshake(null)).toBe(false);
  });

  it('lands back on an in-app path with the outcome, never elsewhere', () => {
    expect(notionConnectReturnPath('/dashboard/assets/new', 'connected')).toBe(
      '/dashboard/assets/new?notion=connected',
    );
    expect(notionConnectReturnPath('https://evil.example/x', 'failed')).toBe('/dashboard?notion=failed');
    expect(notionConnectReturnPath('//evil.example', 'canceled')).toBe('/dashboard?notion=canceled');
    expect(isNotionConnectOutcome('connected')).toBe(true);
    expect(isNotionConnectOutcome('anything')).toBe(false);
  });
});

describe('wizard copy', () => {
  it('has every Notion string in both languages', () => {
    const keys = Object.keys(en.dashboard.newLibrary.wizard).filter((k) => k.startsWith('notion'));
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) {
      expect(zh.dashboard.newLibrary.wizard).toHaveProperty(key);
    }
    expect(Object.keys(zh.dashboard.newLibrary.wizard.errorNotion)).toEqual(
      Object.keys(en.dashboard.newLibrary.wizard.errorNotion),
    );
  });
});
