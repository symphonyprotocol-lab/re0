import { describe, expect, it } from 'vitest';
import { ANONYMOUS_HISTORY_CHARS, ANONYMOUS_HISTORY_TURNS } from '@/lib/constants';
import { anonymousDay, anonymousHistory, ipBucket, refusalCodeOf, validAnonymousId, validFingerprint } from '@/lib/domain/anonymous-chat';

describe('anonymous chat', () => {
  it('counts by the UTC date', () => {
    expect(anonymousDay(new Date('2026-03-01T23:59:59Z'))).toBe('2026-03-01');
    expect(anonymousDay(new Date('2026-03-02T00:00:00Z'))).toBe('2026-03-02');
    /* 08:30 in Tokyo on the 2nd is still the 1st in UTC. */
    expect(anonymousDay(new Date('2026-03-02T08:30:00+09:00'))).toBe('2026-03-01');
  });

  it('accepts only plausible fingerprints and server-issued ids', () => {
    expect(validFingerprint('a'.repeat(64))).toBe(true);
    expect(validFingerprint('short')).toBe(false);
    expect(validFingerprint('x'.repeat(129))).toBe(false);
    expect(validFingerprint('has spaces in it, sixteen+')).toBe(false);
    expect(validFingerprint(null)).toBe(false);
    expect(validAnonymousId(crypto.randomUUID())).toBe(true);
    expect(validAnonymousId('not-a-uuid')).toBe(false);
  });

  it('keeps well-formed recent turns within the caps, starting on a question', () => {
    expect(anonymousHistory('nope')).toEqual([]);
    expect(
      anonymousHistory([
        { role: 'assistant', content: 'loose' },
        { role: 'user', content: '  Q1  ' },
        { role: 'system', content: 'S' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: '' },
        null,
        { role: 'user', content: 42 },
      ]),
    ).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
    ]);

    const many = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn ${index}` }));
    const kept = anonymousHistory(many);
    expect(kept).toHaveLength(ANONYMOUS_HISTORY_TURNS);
    expect(kept.at(-1)!.content).toBe('turn 39');
    expect(kept[0]!.role).toBe('user');

    const long = 'x'.repeat(Math.floor(ANONYMOUS_HISTORY_CHARS / 2) + 1);
    const sized = anonymousHistory([
      { role: 'user', content: long },
      { role: 'assistant', content: long },
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: 'recent answer' },
    ]);
    /* The oldest question no longer fits, so the answer it left at the front goes too. */
    expect(sized).toEqual([
      { role: 'user', content: 'recent question' },
      { role: 'assistant', content: 'recent answer' },
    ]);
    expect(sized.reduce((sum, turn) => sum + turn.content.length, 0)).toBeLessThanOrEqual(ANONYMOUS_HISTORY_CHARS);
  });

  it('counts an address as IPv4, or IPv6 by its /64', () => {
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9');
    expect(ipBucket(' 2001:DB8:1:2:aaaa:bbbb:cccc:dddd ')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:0db8:0001:0002::1')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('[2001:db8:1:2::1]')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(ipBucket('::1')).toBe('0:0:0:0::/64');
    expect(ipBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
    /* Not an address: kept as given rather than merged with others. */
    expect(ipBucket('1:2:3:4:5:6:7:8:9')).toBe('1:2:3:4:5:6:7:8:9');
    expect(ipBucket('2001:db8::1::2')).toBe('2001:db8::1::2');
  });

  it('names each refusal by the limit that refused it', () => {
    expect(refusalCodeOf('visitor')).toBe('anonymous_quota_exceeded');
    expect(refusalCodeOf('network')).toBe('anonymous_network_limit');
    expect(refusalCodeOf('ree')).toBe('anonymous_capacity_reached');
    expect(refusalCodeOf('platform')).toBe('anonymous_capacity_reached');
  });
});
