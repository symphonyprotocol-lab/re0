/**
 * The client address: `x-real-ip`, which Vercel sets itself, before the
 * first `x-forwarded-for` entry, which a client can write when a proxy only
 * appends to it. Null when there is neither (local runs).
 */
export function clientIp(headers: Headers): string | null {
  return headers.get('x-real-ip')?.trim() || headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}
