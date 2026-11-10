import { beforeAll, describe, expect, it } from 'vitest';
import { legacySeal } from '../fixtures/legacy-seal';

/**
 * Sealed tickets are bound to their purpose (review: one key, no purpose
 * binding): a ticket opens only for the purpose it was sealed for, and a
 * ticket from before purposes opens only where the caller vouches for it.
 */
beforeAll(() => {
  process.env.AUTH_SECRET ??= 'test-auth-secret-that-is-long-enough-0000';
});

const { seal, unseal } = await import('@/lib/infra/crypto/sealed');

describe('sealed tickets', () => {
  it('opens a ticket for its own purpose only', async () => {
    const ticket = await seal('admin-enrol-totp', { secret: 'ABC', issuedAt: 1, binding: 'x' });
    expect(await unseal('admin-enrol-totp', ticket)).toEqual({ secret: 'ABC', issuedAt: 1, binding: 'x' });
    expect(await unseal('admin-bootstrap-totp', ticket)).toBeNull();
    expect(await unseal('admin-invite', ticket, () => true)).toBeNull();
    expect(await unseal('oauth-handshake', ticket)).toBeNull();
  });

  it('refuses tampering', async () => {
    const ticket = await seal('github-connect', { purpose: 'github_connect' });
    const [version, iv, data] = ticket.split('.');
    const flipped = `${version}.${iv}.${data!.slice(0, -2)}${data!.endsWith('A') ? 'B' : 'A'}${data!.slice(-1)}`;
    expect(await unseal('github-connect', flipped)).toBeNull();
    expect(await unseal('github-connect', `${iv}.${data}`, () => true)).toBeNull();
    expect(await unseal('github-connect', '')).toBeNull();
    expect(await unseal('github-connect', 'v2.only')).toBeNull();
  });

  it('opens a ticket from before purposes only where the caller vouches for its kind', async () => {
    const invite = await legacySeal({ purpose: 'admin-invite', id: 'x', expiresAt: 1 });
    const isInvite = (payload: unknown) => (payload as { purpose?: unknown } | null)?.purpose === 'admin-invite';
    expect(await unseal('admin-invite', invite, isInvite)).toMatchObject({ id: 'x' });
    expect(await unseal('admin-invite', invite)).toBeNull();
    /* The bootstrap secret has no fallback: an old ticket of any kind is refused there. */
    expect(await unseal('admin-bootstrap-totp', await legacySeal({ secret: 'ABC', issuedAt: Date.now() }))).toBeNull();
    /* A fallback that checks the kind turns away an old ticket of another kind. */
    expect(await unseal('admin-invite', await legacySeal({ purpose: 'github_connect' }), isInvite)).toBeNull();
  });
});
