/**
 * The two things that make a configurable embedding width safe: the padding
 * is geometry-preserving, and a credential written to a row cannot be read
 * back out of it without the deployment's own secret.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMBEDDING_COLUMN_DIMENSIONS,
  EMBEDDING_DIMENSIONS,
  isModelKind,
  mayCarryCredential,
  padToColumn,
  timeoutBoundsFor,
} from '@/lib/domain/model-config';
import {
  forgetCredentialKey,
  isCredentialKeyConfigured,
  openCredential,
  sealCredential,
} from '@/lib/infrastructure/crypto/credentials';

function cosine(a: readonly number[], b: readonly number[]): number {
  const dot = a.reduce((sum, value, at) => sum + value * b[at]!, 0);
  const magnitude = (v: readonly number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return dot / (magnitude(a) * magnitude(b));
}

describe('embedding width', () => {
  it('pads a narrower model into the stored column', () => {
    const padded = padToColumn([1, 2, 3]);
    expect(padded).toHaveLength(EMBEDDING_COLUMN_DIMENSIONS);
    expect(padded.slice(0, 3)).toEqual([1, 2, 3]);
    expect(padded.slice(3).every((value) => value === 0)).toBe(true);
  });

  /*
   * The whole reason the column can stay fixed while the model's width is
   * configuration: zero coordinates contribute to neither the dot product nor
   * either magnitude, so a 1,024-dimensional model ranks in a 1,536-wide
   * column exactly as it would in its own.
   */
  it('leaves cosine distance unchanged, which is what makes the padding safe', () => {
    const a = Array.from({ length: 1_024 }, (_, at) => Math.sin(at));
    const b = Array.from({ length: 1_024 }, (_, at) => Math.cos(at / 3));
    expect(cosine(padToColumn(a), padToColumn(b))).toBeCloseTo(cosine(a, b), 12);
  });

  it('refuses a vector wider than the column rather than truncating it', () => {
    const tooWide = new Array<number>(EMBEDDING_COLUMN_DIMENSIONS + 1).fill(0.1);
    expect(() => padToColumn(tooWide)).toThrow(/does not fit/);
  });

  it('bounds a configurable width by the column, and gives each kind its own clock', () => {
    expect(EMBEDDING_DIMENSIONS.max).toBe(EMBEDDING_COLUMN_DIMENSIONS);
    expect(EMBEDDING_DIMENSIONS.min).toBeLessThan(EMBEDDING_DIMENSIONS.max);
    /* A build's embedding call and a request's rerank call cannot share a
       limit: one runs for minutes, the other must not outlast a request. */
    expect(timeoutBoundsFor('embedding').max).toBeGreaterThan(timeoutBoundsFor('rerank').max);
    expect(isModelKind('embedding')).toBe(true);
    expect(isModelKind('generation')).toBe(false);
  });
});

/*
 * A stored key follows its own origin and nowhere else. Otherwise anyone with
 * the `models` capability could re-point an entry, or probe it, at a host of
 * their own and receive a key somebody else typed as a Bearer header.
 */
describe('carrying a stored credential', () => {
  it('allows a path or trailing-slash change on the same origin', () => {
    expect(mayCarryCredential('https://api.openai.com/v1', 'https://api.openai.com/v1/')).toBe(true);
    expect(mayCarryCredential('https://api.openai.com/v1', 'https://api.openai.com/v2')).toBe(true);
  });

  it('refuses another host, scheme or port, and anything unparseable', () => {
    expect(mayCarryCredential('https://api.openai.com/v1', 'https://attacker.example/v1')).toBe(false);
    expect(mayCarryCredential('https://api.openai.com/v1', 'https://api.openai.com.evil.test/v1')).toBe(
      false,
    );
    expect(mayCarryCredential('https://api.openai.com/v1', 'http://api.openai.com/v1')).toBe(false);
    expect(mayCarryCredential('https://api.openai.com/v1', 'https://api.openai.com:8443/v1')).toBe(
      false,
    );
    expect(mayCarryCredential('https://api.openai.com/v1', 'not a url')).toBe(false);
  });
});

describe('provider credentials', () => {
  const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(48);
    forgetCredentialKey();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = saved;
    forgetCredentialKey();
  });

  it('round-trips a key, and stores neither it nor a repeatable ciphertext', async () => {
    const key = 'sk-or-v1-0123456789abcdef';
    const sealed = await sealCredential(key);
    expect(sealed).not.toContain(key);
    expect(await openCredential(sealed)).toBe(key);
    /* A fresh nonce per seal, so two rows holding the same key do not
       advertise that they do. */
    expect(await sealCredential(key)).not.toBe(sealed);
  });

  it('refuses to open a row that was tampered with, or sealed under another secret', async () => {
    const sealed = await sealCredential('sk-fixture');
    const [nonce, body] = sealed.split('.');
    const flipped = `${nonce}.${body!.slice(0, -2)}${body!.slice(-2) === 'AA' ? 'AB' : 'AA'}`;
    expect(await openCredential(flipped)).toBeNull();

    process.env.CREDENTIAL_ENCRYPTION_KEY = 'b'.repeat(48);
    forgetCredentialKey();
    /* Null, not a throw: a credential under a rotated secret is a stage that
       cannot run, reported as an unconfigured provider rather than as an
       error on every request. */
    expect(await openCredential(sealed)).toBeNull();
  });

  it('reports a missing or too-short secret rather than sealing under a weak one', async () => {
    expect(isCredentialKeyConfigured()).toBe(true);
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'short';
    forgetCredentialKey();
    expect(isCredentialKeyConfigured()).toBe(false);
    await expect(sealCredential('sk-fixture')).rejects.toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    expect(await openCredential(null)).toBeNull();
  });
});
