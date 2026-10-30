import { describe, expect, it } from 'vitest';
import {
  API_KEY_ENVIRONMENTS,
  API_KEY_MANAGEMENT_SCOPE,
  API_KEY_READ_SCOPES,
  API_KEY_SCOPES,
  API_KEY_WRITE_SCOPE,
  apiKeyPrefix,
  hasScope,
  isApiKeyEnvironment,
  isApiKeyIdle,
  maskApiKey,
  normaliseScopes,
  parseScopes,
} from '@/lib/domain/api-key';
import { API_KEY_PREFIXES, requireScope } from '@/lib/application/auth/api-key';
import { canManageApiKeys } from '@/lib/application/assets';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';

/**
 * requirement.md 5.2: a key is narrowed to scopes at creation. Rows minted
 * before scopes existed carry `retrieval`, which meant everything a key could
 * do; they must keep working exactly as before.
 */
describe('normaliseScopes', () => {
  it('reads the legacy word as the read scopes, never as assets:write', () => {
    expect(normaliseScopes(['retrieval'])).toEqual([...API_KEY_READ_SCOPES]);
    expect(normaliseScopes(['retrieval'])).not.toContain(API_KEY_WRITE_SCOPE);
  });

  it('keeps assets:write when it was granted', () => {
    expect(normaliseScopes(['knowledge:read', 'assets:write'])).toEqual(['knowledge:read', 'assets:write']);
    expect(parseScopes(['assets:write'])).toEqual(['assets:write']);
  });

  it('keeps known scopes, the management scope, and nothing else', () => {
    expect(normaliseScopes(['knowledge:read', 'made:up', API_KEY_MANAGEMENT_SCOPE, 7])).toEqual([
      'knowledge:read',
      API_KEY_MANAGEMENT_SCOPE,
    ]);
  });

  it('dedupes and survives an empty or missing column', () => {
    expect(normaliseScopes(['usage:read', 'usage:read'])).toEqual(['usage:read']);
    expect(normaliseScopes(null)).toEqual([]);
    expect(normaliseScopes(undefined)).toEqual([]);
  });
});

/** What a form or JSON body may ask to grant. */
describe('parseScopes', () => {
  it('accepts a list or a single value of grantable scopes', () => {
    expect(parseScopes(['knowledge:search', 'usage:read'])).toEqual([
      'knowledge:search',
      'usage:read',
    ]);
    expect(parseScopes('knowledge:read')).toEqual(['knowledge:read']);
  });

  it('refuses the reserved management scope, unknown scopes and nothing at all', () => {
    expect(parseScopes([API_KEY_MANAGEMENT_SCOPE])).toBeNull();
    expect(parseScopes(['knowledge:read', 'retrieval'])).toBeNull();
    expect(parseScopes([])).toBeNull();
    expect(parseScopes(undefined)).toBeNull();
    expect(parseScopes({ scope: 'knowledge:read' })).toBeNull();
  });
});

/**
 * requirement.md 11: a scope refusal is `access_denied` -- the key is real,
 * it just cannot do this -- and callers without a key are someone else's
 * gate to refuse.
 */
describe('requireScope', () => {
  it('lets a key with the scope through', () => {
    expect(() => requireScope({ scopes: ['knowledge:read'] }, 'knowledge:read')).not.toThrow();
  });

  it('refuses a key without it as access_denied', () => {
    expect(() => requireScope({ scopes: ['knowledge:read'] }, 'usage:read')).toThrow(
      expect.objectContaining({ code: 'access_denied' }),
    );
    expect(() => requireScope({ scopes: [] }, 'knowledge:search')).toThrow(
      expect.objectContaining({ code: 'access_denied' }),
    );
  });

  it('passes session and anonymous callers, which carry no scopes', () => {
    expect(() => requireScope({ scopes: undefined }, 'usage:read')).not.toThrow();
    expect(() => requireScope(null, 'usage:read')).not.toThrow();
  });

  it('honours the management scope only when the key holds it', () => {
    expect(hasScope([API_KEY_MANAGEMENT_SCOPE], API_KEY_MANAGEMENT_SCOPE)).toBe(true);
    expect(() => requireScope({ scopes: [...API_KEY_SCOPES] }, API_KEY_MANAGEMENT_SCOPE)).toThrow(
      expect.objectContaining({ code: 'access_denied' }),
    );
  });
});

describe('key presentation', () => {
  it('names the environment in the prefix', () => {
    expect(apiKeyPrefix('live')).toBe('mm_live_');
    expect(apiKeyPrefix('test')).toBe('mm_test_');
  });

  it('masks to prefix and last four, nothing in between', () => {
    expect(maskApiKey('mm_live_', 'ab12')).toBe('mm_live_••••ab12');
  });

  it('counts a key idle after thirty days, from creation when never used', () => {
    const now = new Date('2026-09-07T00:00:00Z');
    expect(isApiKeyIdle({ lastUsedAt: '2026-08-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }, now)).toBe(true);
    expect(isApiKeyIdle({ lastUsedAt: '2026-09-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }, now)).toBe(false);
    expect(isApiKeyIdle({ lastUsedAt: null, createdAt: '2026-09-01T00:00:00Z' }, now)).toBe(false);
    expect(isApiKeyIdle({ lastUsedAt: null, createdAt: '2026-07-01T00:00:00Z' }, now)).toBe(true);
  });
});

/**
 * requirement.md 3.3: keys are the owner's. `createApiKey`, `rotateApiKey`
 * and `revokeApiKey` all enforce it, so the screen has to render the controls
 * to match -- an admin or a developer used to be shown Rotate and Revoke and
 * got a raw server-action error digest for pressing either.
 */
describe('who may manage keys', () => {
  it('is the owner and nobody else', () => {
    expect(canManageApiKeys('owner')).toBe(true);
    for (const role of ['admin', 'developer', 'viewer'] as const) {
      expect(canManageApiKeys(role), role).toBe(false);
    }
  });

  it('has a refusal message for the roles it turns away', () => {
    /* The page shows this instead of a create panel that cannot succeed, so
       a non-owner is told who to ask rather than left to press a button. */
    for (const dictionary of [en, zh]) {
      const scoped = dictionary.dashboard.apiKeys.scoped;
      expect(scoped.ownerOnlyTitle.length).toBeGreaterThan(0);
      expect(scoped.ownerOnlyBody.length).toBeGreaterThan(0);
    }
  });
});

/**
 * What `environment` means, decided and then held to.
 *
 * requirement.md 5.2 asks only that a key name an environment, and
 * architecture.md 5.1 fixes the two prefixes. Neither makes a `mm_test_` key
 * a sandbox, and nothing in the quota or metering path reads the column: a
 * Test key spends the same allowance and bills the same as a Live one. So the
 * environment stays a label -- these tests pin that it is honestly a label on
 * both sides, in the resolver and in the words the screen prints.
 */
describe('key environments', () => {
  it('names both environments in the prefix, and admits both identically', () => {
    expect(API_KEY_ENVIRONMENTS.map(apiKeyPrefix)).toEqual([...API_KEY_PREFIXES]);
  });

  it('recognises only the two the catalogue defines', () => {
    expect(isApiKeyEnvironment('live')).toBe(true);
    expect(isApiKeyEnvironment('test')).toBe(true);
    expect(isApiKeyEnvironment('sandbox')).toBe(false);
    expect(isApiKeyEnvironment('staging')).toBe(false);
    expect(isApiKeyEnvironment(null)).toBe(false);
  });

  it('says in both dictionaries that Test is not a free ride', () => {
    /* The word "Test" invites the opposite assumption, and an unmetered
       environment nobody implemented would be a hole through the plan's
       allowance. The note has to exist wherever the environment is read. */
    for (const dictionary of [en, zh]) {
      const scoped = dictionary.dashboard.apiKeys.scoped;
      expect(Object.keys(scoped.environments).sort()).toEqual([...API_KEY_ENVIRONMENTS].sort());
      expect(scoped.environmentNote.length).toBeGreaterThan(0);
    }
  });
});
