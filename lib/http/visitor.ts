/**
 * The key an anonymous visitor is counted under, for the channel directory's
 * activity term (agent-first-proposal.md 6.4): the caller's address and
 * device signal (the user agent), through the same HMAC the anonymous rate
 * limiter uses, so neither is ever stored or logged in the clear
 * (architecture.md 11.2). Distinct per day is all it is used for.
 */
import { hmacSha256 } from '@/lib/infrastructure/crypto/tokens';
import { clientAddress, type HeaderBag } from '@/lib/http/client-address';

export async function anonymousVisitorKey(headers: HeaderBag): Promise<string | null> {
  const secret = process.env.SESSION_SIGNING_SECRET;
  if (!secret || secret.length < 32) return null;
  const address = clientAddress(headers) ?? 'unknown';
  const device = headers.get('user-agent') ?? '';
  return (await hmacSha256(secret, `visitor|${address}|${device}`)).slice(0, 48);
}
