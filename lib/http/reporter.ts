import type { NextRequest } from 'next/server';
import { reportBucket } from '@/lib/domain/anonymous-chat';
import { clientIp } from '@/lib/http/conversations';
import { quotaKeyHash } from '@/lib/services/anonymous-chat';

/**
 * Who a report counts for (public answers, post answers, posts): an account
 * by its id; a visitor by their network -- the address, IPv6 by /48
 * (`reportBucket`), stored as an HMAC -- whatever cookie they send. Null
 * without an address: the route refuses the report.
 */
export async function reporterKey(request: NextRequest, userId: string | null): Promise<string | null> {
  if (userId) return `user:${userId}`;
  const ip = clientIp(request.headers);
  return ip ? `anon-ip:${await quotaKeyHash('ip', reportBucket(ip))}` : null;
}
