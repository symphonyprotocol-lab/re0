/**
 * The import rule for GitHub repositories (lib/domain/github.ts): a
 * workspace imports its own public, non-fork repositories and nothing else,
 * decided by the owner's account id rather than the login, and the same
 * predicate filters the wizard's list and refuses at submit.
 */
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

import { describe, expect, it } from 'vitest';
import {
  GITHUB_CONNECT_SCOPE,
  grantScopeCovers,
  importableRepositories,
  importRefusal,
  isGithubConnectHandshake,
  isGithubConnectOutcome,
  type RepositoryFacts,
} from '@/lib/domain/github';
import { connectReturnPath } from '@/lib/application/auth/github-connection';

const mine: RepositoryFacts = {
  id: 1,
  fullName: 'octocat/docs',
  ownerId: 42,
  private: false,
  fork: false,
  archived: false,
  permission: 'admin',
};

describe('repository import rule', () => {
  it('accepts a public, non-fork repository the account owns', () => {
    expect(importRefusal(mine, '42')).toBeNull();
    expect(importRefusal({ ...mine, archived: true }, '42')).toBeNull();
  });

  it('refuses forks and private repositories', () => {
    expect(importRefusal({ ...mine, fork: true }, '42')).toBe('fork');
    expect(importRefusal({ ...mine, private: true }, '42')).toBe('private');
  });

  it('refuses another account’s repository first, whatever else is wrong with it', () => {
    const theirs = { ...mine, permission: 'read' as const };
    expect(importRefusal(theirs, '7')).toBe('not_owner');
    expect(importRefusal({ ...theirs, private: true, fork: true }, '7')).toBe('not_owner');
  });

  it('accepts an organisation repository only with admin or maintain rights', () => {
    const org = { ...mine, ownerId: 9000 };
    expect(importRefusal({ ...org, permission: 'admin' }, '42')).toBeNull();
    expect(importRefusal({ ...org, permission: 'maintain' }, '42')).toBeNull();
    expect(importRefusal({ ...org, permission: 'write' }, '42')).toBe('not_owner');
    expect(importRefusal({ ...org, permission: 'read' }, '42')).toBe('not_owner');
    expect(importRefusal({ ...org, permission: 'none' }, '42')).toBe('not_owner');
  });

  it('filters a listing with the same rule', () => {
    const listed = importableRepositories(
      [
        mine,
        { ...mine, id: 2, fullName: 'octocat/forked', fork: true },
        { ...mine, id: 3, fullName: 'octocat/secret', private: true },
        { ...mine, id: 4, fullName: 'someone/else', ownerId: 7, permission: 'read' },
        { ...mine, id: 5, fullName: 'octocat/old', archived: true },
        { ...mine, id: 6, fullName: 'org/admin-here', ownerId: 9000, permission: 'admin' },
        { ...mine, id: 7, fullName: 'org/member-only', ownerId: 9000, permission: 'write' },
      ],
      '42',
    );
    expect(listed.map((repository) => repository.fullName)).toEqual([
      'octocat/docs',
      'octocat/old',
      'org/admin-here',
    ]);
  });

  it('asks for no repository write scope, and notices a grant that predates a scope', () => {
    expect(GITHUB_CONNECT_SCOPE).not.toMatch(/repo/);
    expect(grantScopeCovers('read:user read:org')).toBe(true);
    expect(grantScopeCovers('read:org,read:user,gist')).toBe(true);
    expect(grantScopeCovers('read:user')).toBe(false);
    expect(grantScopeCovers('')).toBe(false);
  });
});

describe('connect handshake and outcome', () => {
  it('recognises only its own handshake shape', () => {
    expect(
      isGithubConnectHandshake({ purpose: 'github_connect', state: 's', returnTo: '/dashboard', expiresAt: 1 }),
    ).toBe(true);
    /* The login handshake has no purpose field; it must not pass for a connect one. */
    expect(
      isGithubConnectHandshake({ provider: 'github', state: 's', nonce: 'n', codeVerifier: 'v', returnTo: '/', expiresAt: 1 }),
    ).toBe(false);
    expect(isGithubConnectHandshake(null)).toBe(false);
  });

  it('lands back on an in-app path with the outcome, never elsewhere', () => {
    expect(connectReturnPath('/dashboard/assets/new', 'connected')).toBe(
      '/dashboard/assets/new?github=connected',
    );
    expect(connectReturnPath('https://evil.example/x', 'failed')).toBe('/dashboard?github=failed');
    expect(connectReturnPath('//evil.example', 'canceled')).toBe('/dashboard?github=canceled');
    expect(isGithubConnectOutcome('connected')).toBe(true);
    expect(isGithubConnectOutcome('anything')).toBe(false);
  });
});
