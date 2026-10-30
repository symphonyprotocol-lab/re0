/**
 * The P1 rules that need no database: reserved names, handles, channel slugs,
 * the 6.2 visibility matrix, the directory score, policy entries that name a
 * channel, A2A tenants, the three Agent Card levels and how a message picks
 * its skill. agent-first-proposal.md 3.2, 6.1-6.4, 7.1-7.5.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Role, type Message } from '@a2a-js/sdk';
import { hasReservedOwner, isReservedName, RESERVED_NAMES } from '@/lib/domain/reserved-names';
import { handleRefusal, normalizeHandle, suffixedHandle, suggestHandle } from '@/lib/domain/handle';
import {
  assetSight,
  channelSlugFromTitle,
  draftChannel,
  freshness,
  hotScores,
  normalizeChannelSlug,
  quality,
  ChannelRefused,
} from '@/lib/domain/channel';
import { assetKindOf, needsClaimForPublic } from '@/lib/domain/asset';
import { normalizePublicId } from '@/lib/domain/library';
import { evaluatePolicy, listedIn, OPEN_POLICY, parsePolicyEntry } from '@/lib/domain/policy';
import { parseTenantKey, splitTenantPath, PLATFORM_TENANT, type A2ATenant } from '@/lib/application/a2a/tenant';
import { agentCardJson, buildAgentCard, cardUrl } from '@/lib/application/a2a/card';
import { readSkillRequest, SkillRejected, skillRefusal } from '@/lib/application/a2a/executor';

/* ------------------------------------------------------------ reserved names */

describe('reserved names', () => {
  it('cover every first path segment the app serves', () => {
    const root = join(process.cwd(), 'app');
    const segments = new Set<string>();
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (!statSync(join(dir, entry)).isDirectory()) continue;
        /* A route group adds no segment; its children are first segments too. */
        if (entry.startsWith('(') && entry.endsWith(')')) collect(join(dir, entry));
        else if (!entry.startsWith('[') && !entry.startsWith('_')) segments.add(entry);
      }
    };
    collect(root);
    expect(segments.size).toBeGreaterThan(5);
    for (const segment of segments) expect([segment, isReservedName(segment)]).toEqual([segment, true]);
  });

  it('are the ones migration 0062 kept out of backfilled handles', () => {
    const sql = readFileSync(join(process.cwd(), 'db/migrations/0062_agent_first_p1.sql'), 'utf8');
    const block = /OR base IN \(([^)]*)\)/.exec(sql)![1]!;
    const listed = new Set([...block.matchAll(/'([^']+)'/g)].map((match) => match[1]));
    /* Only names a handle could take: the handle alphabet has no dot. */
    for (const name of RESERVED_NAMES) {
      if (/^[a-z0-9-]+$/.test(name) && name.length >= 3) expect([name, listed.has(name)]).toEqual([name, true]);
    }
  });

  it('include the namespaces proposal 3.2 names', () => {
    for (const name of ['websites', 'docs', 'notion', 'posts', 'audio', 'qa', 'channels', 'u', 'a2a', 'admin', 'dashboard', 'api', 'v1']) {
      expect(RESERVED_NAMES.has(name)).toBe(true);
    }
  });

  it('refuse a repository id under a reserved owner, whatever its case', () => {
    expect(normalizePublicId('github', '/channels/repo')).toBeNull();
    expect(normalizePublicId('github', 'Dashboard/repo')).toBeNull();
    expect(normalizePublicId('github', '/vercel/next.js')).toBe('/vercel/next.js');
    expect(hasReservedOwner('https://github.com/A2A/thing')).toBe(true);
    expect(hasReservedOwner('octocat/docs')).toBe(false);
  });
});

/* ------------------------------------------------------------------ handles */

describe('handles', () => {
  it('are 3-32 lowercase letters, digits and single inner dashes, not reserved', () => {
    expect(handleRefusal('alice')).toBeNull();
    expect(handleRefusal('a-b-c')).toBeNull();
    expect(handleRefusal('ab')).toBe('invalid');
    expect(handleRefusal('-alice')).toBe('invalid');
    expect(handleRefusal('alice-')).toBe('invalid');
    expect(handleRefusal('al--ice')).toBe('invalid');
    expect(handleRefusal('Alice')).toBe('invalid');
    expect(handleRefusal('x'.repeat(33))).toBe('invalid');
    expect(handleRefusal('channels')).toBe('reserved');
    expect(normalizeHandle('  Alice ')).toBe('alice');
  });

  it('are suggested from the email and stay valid when suffixed', () => {
    expect(suggestHandle('Zoë.Smith+re0@example.com', '0192aaaa-0000-7000-8000-00000000abcd')).toBe('zoe-smith-re0');
    expect(suggestHandle('ab@example.com', '0192aaaa-0000-7000-8000-00000000abcd')).toBe('user-00abcd');
    expect(suggestHandle('admin@example.com', '0192aaaa-0000-7000-8000-00000000abcd')).toBe('user-00abcd');
    const long = suffixedHandle('x'.repeat(32), 2, '0192aaaa-0000-7000-8000-00000000abcd');
    expect(handleRefusal(long)).toBeNull();
  });
});

/* ----------------------------------------------------------------- channels */

describe('channel slugs and drafts', () => {
  it('fold, refuse the platform slug and suggest from a title', () => {
    expect(normalizeChannelSlug('Rust-Notes')).toBe('rust-notes');
    expect(normalizeChannelSlug('re0')).toBeNull();
    expect(normalizeChannelSlug('a')).toBeNull();
    expect(channelSlugFromTitle('Café Notes!')).toBe('cafe-notes');
    expect(channelSlugFromTitle('中文频道')).toBe('');
  });

  it('default to public and name the field a refusal is about', () => {
    expect(draftChannel({ slug: 'notes', title: 'Notes' }).visibility).toBe('public');
    expect(draftChannel({ slug: 'notes', title: 'Notes', visibility: 'private' }).visibility).toBe('private');
    expect(() => draftChannel({ slug: 'x', title: 'Notes' })).toThrow(ChannelRefused);
    try {
      draftChannel({ slug: 'notes', title: '   ' });
    } catch (error) {
      expect((error as ChannelRefused).code).toBe('invalid_title');
    }
  });
});

describe('who sees an asset (proposal 6.2)', () => {
  const pub = { visibility: 'public' as const, status: 'active' as const };
  it('follows the matrix', () => {
    /* In no channel: the owner alone. */
    expect(assetSight({ isOwner: true, channel: null, access: 'free' })).toBe('full');
    expect(assetSight({ isOwner: false, isSubscriber: true, channel: null, access: 'free' })).toBe('none');
    /* A private channel: the owner alone. */
    expect(assetSight({ isOwner: false, isSubscriber: true, channel: { visibility: 'private', status: 'active' }, access: 'free' })).toBe('none');
    /* A public channel: free for everyone, paid by summary to strangers. */
    expect(assetSight({ isOwner: false, channel: pub, access: 'free' })).toBe('full');
    expect(assetSight({ isOwner: false, channel: pub, access: 'paid' })).toBe('summary');
    expect(assetSight({ isOwner: false, isSubscriber: true, channel: pub, access: 'paid' })).toBe('full');
    /* A suspended channel shows nothing to anyone but its owner. */
    expect(assetSight({ isOwner: false, channel: { visibility: 'public', status: 'suspended' }, access: 'free' })).toBe('none');
    expect(assetSight({ isOwner: true, channel: { visibility: 'public', status: 'suspended' }, access: 'paid' })).toBe('full');
  });

  it('asks website and repository assets for proof of control before going public', () => {
    expect(assetKindOf('pdf')).toBe('upload');
    expect(assetKindOf('markdown')).toBe('upload');
    expect(needsClaimForPublic('website')).toBe(true);
    expect(needsClaimForPublic('github')).toBe(true);
    expect(needsClaimForPublic('upload')).toBe(false);
    expect(needsClaimForPublic('notion')).toBe(false);
  });
});

describe('the directory score (proposal 6.4)', () => {
  const now = new Date('2026-10-30T00:00:00Z');
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);

  it('halves freshness every half-life and averages quality into 0-1', () => {
    expect(freshness(now, now, 14)).toBe(1);
    expect(freshness(days(14), now, 14)).toBeCloseTo(0.5, 6);
    expect(freshness(null, now, 14)).toBe(0);
    expect(quality([{ trust: 100, benchmark: 100 }, { trust: 0, benchmark: 0 }])).toBe(0.5);
  });

  it('counts people on a log scale, so one busy caller cannot buy rank', () => {
    const scores = hotScores(
      [
        { id: 'many', activity: { users: 40, workspaces: 5, anonymous: 200 }, lastUpdatedAt: days(30), scores: [] },
        { id: 'fresh', activity: { users: 0, workspaces: 0, anonymous: 0 }, lastUpdatedAt: now, scores: [{ trust: 100, benchmark: 100 }] },
        { id: 'idle', activity: { users: 1, workspaces: 0, anonymous: 0 }, lastUpdatedAt: days(120), scores: [] },
      ],
      now,
    );
    expect(scores.get('many')!).toBeGreaterThan(scores.get('idle')!);
    expect(scores.get('fresh')!).toBeGreaterThan(scores.get('idle')!);
    /* The busiest channel's activity term is 1 by construction; weights default to 0.5/0.25/0.25. */
    expect(scores.get('many')!).toBeLessThanOrEqual(1);
  });

  it('follows the console weights', () => {
    const entries = [
      { id: 'busy', activity: { users: 10, workspaces: 0, anonymous: 0 }, lastUpdatedAt: days(100), scores: [] },
      { id: 'new', activity: { users: 0, workspaces: 0, anonymous: 0 }, lastUpdatedAt: now, scores: [] },
    ];
    const byActivity = hotScores(entries, now, { activityBps: 10_000, freshnessBps: 0, qualityBps: 0, halfLifeDays: 14 });
    const byFreshness = hotScores(entries, now, { activityBps: 0, freshnessBps: 10_000, qualityBps: 0, halfLifeDays: 14 });
    expect(byActivity.get('busy')!).toBeGreaterThan(byActivity.get('new')!);
    expect(byFreshness.get('new')!).toBeGreaterThan(byFreshness.get('busy')!);
  });
});

describe('access rules that name a channel', () => {
  it('parse as a channel entry and cover every asset in it', () => {
    expect(parsePolicyEntry('/channels/Rust-Notes')).toEqual({ entry: '/channels/rust-notes', kind: 'channel' });
    expect(parsePolicyEntry('/channels/*')).toEqual({ entry: '/channels/*', kind: 'channel' });
    expect(listedIn(['/channels/rust-notes'], { publicId: '/websites/a', channel: '/channels/rust-notes' })).toBe(true);
    expect(listedIn(['/channels/rust-notes'], { publicId: '/websites/a', channel: '/channels/other' })).toBe(false);
    expect(listedIn(['/channels/rust-notes'], { publicId: '/websites/a', channel: null })).toBe(false);
    expect(listedIn(['/channels/*'], { publicId: '/websites/a', channel: '/channels/x' })).toBe(true);
    const blocked = evaluatePolicy(
      { ...OPEN_POLICY, blockedLibraries: ['/channels/rust-notes'] },
      { publicId: '/websites/a', channel: '/channels/rust-notes', sourceTypes: ['website'], trustScore: 0, verified: true, ageDays: null },
    );
    expect(blocked.allowed).toBe(false);
  });
});

/* -------------------------------------------------------------------- A2A */

const CHANNEL: A2ATenant = {
  level: 'channel',
  key: 'channels/rust-notes',
  slug: 'rust-notes',
  channelId: '0192aaaa-0000-7000-8000-000000000001',
  workspaceId: '0192aaaa-0000-7000-8000-000000000002',
  title: 'Rust notes',
  description: 'Notes on Rust.',
  ownerHandle: 'alice',
};
const USER: A2ATenant = {
  level: 'user',
  key: 'users/alice',
  handle: 'alice',
  workspaceId: '0192aaaa-0000-7000-8000-000000000002',
  name: 'Alice',
};

describe('A2A tenants', () => {
  it('parse the three levels and nothing else', () => {
    expect(parseTenantKey('')).toEqual({ level: 'platform' });
    expect(parseTenantKey('users/Alice')).toEqual({ level: 'user', name: 'alice' });
    expect(parseTenantKey('channels/re0')).toEqual({ level: 'channel', name: 're0' });
    expect(parseTenantKey('channels/rust-notes/extra')).toBeNull();
    expect(parseTenantKey('teams/x')).toBeNull();
    expect(parseTenantKey('users/admin')).toBeNull();
  });

  it('split from a path whether the tenant came as one encoded segment or two', () => {
    expect(splitTenantPath(['channels%2Frust-notes', 'message:send'])).toEqual({ tenant: 'channels/rust-notes', rest: ['message:send'] });
    expect(splitTenantPath(['channels', 'rust-notes', 'agent-card.json'])).toEqual({ tenant: 'channels/rust-notes', rest: ['agent-card.json'] });
    expect(splitTenantPath(['message:send'])).toEqual({ tenant: '', rest: ['message:send'] });
    expect(splitTenantPath([])).toEqual({ tenant: '', rest: [] });
  });
});

describe('Agent Cards (proposal 7.1-7.3)', () => {
  const origin = 'https://re0.io';

  it('come from one generator, with the level’s tenant on both 1.0 bindings and the path on the 0.3 one', () => {
    const card = agentCardJson(buildAgentCard({ origin, tenant: CHANNEL })) as {
      supportedInterfaces: { url: string; protocolBinding: string; tenant?: string; protocolVersion: string }[];
      skills: { id: string }[];
      capabilities: { streaming?: boolean; pushNotifications?: boolean };
      securitySchemes: Record<string, unknown>;
      description: string;
    };
    expect(card.supportedInterfaces).toEqual([
      { url: 'https://re0.io/a2a', protocolBinding: 'JSONRPC', tenant: 'channels/rust-notes', protocolVersion: '1.0' },
      { url: 'https://re0.io/a2a', protocolBinding: 'HTTP+JSON', tenant: 'channels/rust-notes', protocolVersion: '1.0' },
      { url: 'https://re0.io/a2a/channels/rust-notes', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ]);
    expect(card.skills.map((skill) => skill.id)).toEqual(['search_context', 'ask']);
    /* P2: push notifications and the authenticated extended card (proposal 7.2, 7.6). */
    expect(card.capabilities.pushNotifications).toBe(true);
    expect(Object.keys(card.securitySchemes)).toEqual(['bearer']);
    /* What makes the results different is stated where agents read it (proposal 7.5). */
    expect(card.description).toMatch(/Verifier/);
  });

  it('give the platform its three public skills and a user without public channels none', () => {
    const platform = buildAgentCard({ origin, tenant: PLATFORM_TENANT });
    expect(platform.skills.map((skill) => skill.id)).toEqual(['find_channels', 'search_context', 'ask']);
    expect(platform.supportedInterfaces[0]!.tenant).toBe('');
    expect(buildAgentCard({ origin, tenant: USER, hasPublicChannel: false }).skills).toEqual([]);
    expect(buildAgentCard({ origin, tenant: USER, hasPublicChannel: true }).skills.map((skill) => skill.id)).toEqual(['search_context', 'ask']);
  });

  const quota = {
    planAllowanceRemaining: 900,
    addonBalanceRemaining: 0,
    capacityBytes: 500 * 1_048_576,
    usedBytes: 1_048_576,
    askCallsPerAnswer: 10,
    askDailyAnswers: 500,
    answersToday: 3,
  };

  it('never list a write skill on a public card; the extended card adds them for the caller’s own assets', () => {
    for (const tenant of [PLATFORM_TENANT, USER, CHANNEL]) {
      const ids = buildAgentCard({ origin, tenant, hasPublicChannel: true }).skills.map((skill) => skill.id);
      expect(ids).not.toContain('ingest');
      expect(ids).not.toContain('refresh');
      expect(ids).not.toContain('publish');
    }
    const platform = buildAgentCard({ origin, tenant: PLATFORM_TENANT, extended: { workspaceId: 'w-any', quota } });
    expect(platform.skills.map((skill) => skill.id)).toEqual(['find_channels', 'search_context', 'ask', 'ingest', 'refresh', 'publish']);
    /* A user card's extended form is the owner's own: anyone else gets the public skills. */
    const own = buildAgentCard({ origin, tenant: USER, hasPublicChannel: false, extended: { workspaceId: USER.level === 'user' ? USER.workspaceId : '', quota } });
    expect(own.skills.map((skill) => skill.id)).toEqual(['search_context', 'ask', 'ingest', 'refresh', 'publish']);
    const stranger = buildAgentCard({ origin, tenant: USER, hasPublicChannel: true, extended: { workspaceId: 'w-other', quota } });
    expect(stranger.skills.map((skill) => skill.id)).toEqual(['search_context', 'ask']);
    expect(buildAgentCard({ origin, tenant: CHANNEL, extended: { workspaceId: 'w-other', quota } }).skills.map((skill) => skill.id)).toEqual([
      'search_context',
      'ask',
    ]);
  });

  it('state the caller’s quota on the extended card, and nothing internal', () => {
    const card = buildAgentCard({ origin, tenant: PLATFORM_TENANT, extended: { workspaceId: 'w-any', quota } });
    expect(card.description).toMatch(/900 Calls left/);
    expect(card.description).toMatch(/3 of 500 ask answers/);
    expect(card.capabilities?.extensions[0]?.params).toMatchObject({ askDailyAnswers: 500, answersToday: 3 });
    const wire = JSON.stringify(agentCardJson(card));
    expect(wire).not.toMatch(/w-any|DATABASE|postgres|localhost|internal/i);
  });

  it('are served where proposal 7.1 says', () => {
    expect(cardUrl(origin, PLATFORM_TENANT)).toBe('https://re0.io/.well-known/agent-card.json');
    expect(cardUrl(origin, USER)).toBe('https://re0.io/a2a/users/alice/agent-card.json');
    expect(cardUrl(origin, CHANNEL)).toBe('https://re0.io/a2a/channels/rust-notes/agent-card.json');
  });
});

describe('how a message picks its skill', () => {
  const message = (parts: Message['parts'], metadata?: Record<string, unknown>): Message => ({
    messageId: 'm1',
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts,
    metadata,
    extensions: [],
    referenceTaskIds: [],
  });
  const text = (value: string) => ({ content: { $case: 'text' as const, value }, metadata: undefined, filename: '', mediaType: '' });
  const data = (value: Record<string, unknown>) => ({ content: { $case: 'data' as const, value }, metadata: undefined, filename: '', mediaType: '' });

  it('defaults to search_context with the text as the query', () => {
    expect(readSkillRequest(message([text('How do lifetimes work?')]), CHANNEL)).toMatchObject({
      skill: 'search_context',
      query: 'How do lifetimes work?',
      maxTokens: 4000,
    });
  });

  it('takes a data part or metadata, and clamps what it is given', () => {
    expect(readSkillRequest(message([data({ skill: 'find_channels', query: 'rust', limit: 99 })]), PLATFORM_TENANT)).toMatchObject({
      skill: 'find_channels',
      query: 'rust',
      limit: 20,
    });
    expect(readSkillRequest(message([text('rust')], { skill: 'find_channels' }), PLATFORM_TENANT).skill).toBe('find_channels');
    expect(readSkillRequest(message([data({ query: 'x', maxTokens: 10 })]), CHANNEL).maxTokens).toBe(256);
  });

  it('refuses what the card does not offer, and an empty or oversized query', () => {
    expect(() => readSkillRequest(message([data({ skill: 'find_channels', query: 'x' })]), CHANNEL)).toThrow(SkillRejected);
    expect(() => readSkillRequest(message([data({ skill: 'summarise', query: 'x' })]), PLATFORM_TENANT)).toThrow(SkillRejected);
    expect(() => readSkillRequest(message([text('   ')]), CHANNEL)).toThrow(SkillRejected);
    expect(() => readSkillRequest(message([text('x'.repeat(2001))]), CHANNEL)).toThrow(SkillRejected);
  });
});

describe('who may use which skill (proposal 7.4)', () => {
  const caller = (scopes: string[] | undefined, workspaceId: string | null = 'w-1') => ({
    workspaceId,
    apiKeyId: workspaceId ? 'k-1' : null,
    requestId: 'r',
    anonymous: workspaceId === null,
    scopes,
  });

  it('needs assets:write for ingest, refresh and publish, and the caller’s own workspace', () => {
    for (const skill of ['ingest', 'refresh', 'publish'] as const) {
      expect(skillRefusal(skill, PLATFORM_TENANT, caller(['knowledge:search', 'knowledge:read']))).toMatch(/assets:write/);
      expect(skillRefusal(skill, PLATFORM_TENANT, caller(undefined, null))).toMatch(/API key/);
      expect(skillRefusal(skill, PLATFORM_TENANT, caller(['assets:write']))).toBeNull();
      expect(skillRefusal(skill, CHANNEL, caller(['assets:write']))).toMatch(/channel/);
      expect(skillRefusal(skill, USER, caller(['assets:write'], 'w-somebody-else'))).toMatch(/own workspace/);
    }
  });

  it('needs a key with a read scope for ask; search stays open to anonymous callers', () => {
    expect(skillRefusal('ask', CHANNEL, caller(undefined, null))).toMatch(/API key/);
    expect(skillRefusal('ask', CHANNEL, caller(['assets:write']))).toMatch(/knowledge:search/);
    expect(skillRefusal('ask', CHANNEL, caller(['knowledge:read']))).toBeNull();
    expect(skillRefusal('search_context', CHANNEL, caller(undefined, null))).toBeNull();
    expect(skillRefusal('search_context', CHANNEL, caller(['assets:write']))).toMatch(/knowledge:search/);
  });
});
