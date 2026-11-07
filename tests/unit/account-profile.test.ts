import { describe, expect, it } from 'vitest';
import { profileChanges, PROFILE_LIMITS } from '@/lib/domain/account';

describe('profile validation', () => {
  it('trims fields, accepts custom handles and URLs, and ignores fully empty contact rows', () => {
    expect(profileChanges({ title: ' Builder ', description: ' About me\n ', website: ' https://example.com ', socialContacts: [{ platform: ' WeChat ', value: ' my-id ' }, { platform: 'X', value: 'https://x.com/me' }, { platform: ' ', value: '' }] })).toEqual({ changes: { title: 'Builder', description: 'About me', website: 'https://example.com', socialContacts: [{ platform: 'WeChat', value: 'my-id' }, { platform: 'X', value: 'https://x.com/me' }] } });
    expect(profileChanges({ lang: 'en' })).toEqual({ changes: {} });
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'ftp://example.com', 'example.com', 'https://', 'https://user:password@example.com'])('rejects invalid website %s', (website) => {
    expect(profileChanges({ website })).toEqual({ error: 'website' });
  });

  it('rejects malformed and oversized fields without coercion or truncation', () => {
    for (const field of ['title', 'description', 'website'] as const) {
      expect(profileChanges({ [field]: 123 })).toEqual({ error: field });
      expect(profileChanges({ [field]: 'a'.repeat(PROFILE_LIMITS[field] + 1) })).toEqual({ error: field });
    }
    for (const socialContacts of [null, {}, [null], [{ platform: 'X', value: '' }], [{ platform: '', value: '@me' }], [{ platform: 'X'.repeat(41), value: '@me' }], [{ platform: 'X', value: 'a'.repeat(301) }], Array.from({ length: 11 }, () => ({ platform: 'X', value: '@me' }))]) {
      expect(profileChanges({ socialContacts })).toEqual({ error: 'socialContacts' });
    }
  });
});
