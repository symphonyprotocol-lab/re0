/**
 * What is left of anonymous chat with free Rees (beyond 4), which ended
 * with the conversation code (2026-11): how a client address is bucketed
 * (reports still count a visitor by network) and the UTC day. The server
 * side is lib/services/anonymous-chat.ts. The console's daily caps went with
 * it (2026-11-21); their table stays as it was.
 */

/**
 * The client address as the per-address key counts it: an IPv4 address as
 * is, an IPv6 address by its /64 (one subscriber's prefix; rotating within
 * it changes nothing), an IPv4-mapped IPv6 address as its IPv4 address.
 * Anything that does not parse is kept as given.
 */
export function ipBucket(ip: string): string {
  let value = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const zone = value.indexOf('%');
  if (zone >= 0) value = value.slice(0, zone);
  if (!value.includes(':')) return value;
  const mapped = /^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value) ?? /^::(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) return mapped[1]!;
  const halves = value.split('::');
  if (halves.length > 2) return value;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 2 && missing < 1) || (halves.length === 1 && missing !== 0)) return value;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return value;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The network a visitor's report counts for: IPv4 by address, IPv6 by /48 --
 * wider than the /64 the anonymous rounds count by, since a home line is
 * often delegated a /56 or /48 and one person must not be three reporters.
 * Only for reports; the rounds keep `ipBucket`.
 */
export function reportBucket(ip: string): string {
  const bucket = ipBucket(ip);
  if (!bucket.endsWith('::/64')) return bucket;
  return `${bucket.slice(0, -'::/64'.length).split(':').slice(0, 3).join(':')}::/48`;
}

/** The day a round counts against: the UTC date, `YYYY-MM-DD`. The one place that decides it. */
export function anonymousDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
