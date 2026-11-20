import { describe, expect, it } from 'vitest';
import { anonymousDay, ipBucket } from '@/lib/domain/anonymous-chat';

/* What is left of anonymous chat: the UTC day of its quota table, and the address buckets reports still count visitors by. */
describe('anonymous chat', () => {
  it('counts by the UTC date', () => {
    expect(anonymousDay(new Date('2026-03-01T23:59:59Z'))).toBe('2026-03-01');
    expect(anonymousDay(new Date('2026-03-02T00:00:00Z'))).toBe('2026-03-02');
    /* 08:30 in Tokyo on the 2nd is still the 1st in UTC. */
    expect(anonymousDay(new Date('2026-03-02T08:30:00+09:00'))).toBe('2026-03-01');
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
});
