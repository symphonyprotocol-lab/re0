/**
 * `POST /api/billing/paddle`: Paddle's notification destination (its URL in
 * the Paddle dashboard must end in this path).
 *
 * The body is read as text and verified untouched: the signature is over the
 * exact bytes. Status codes are the retry policy: 2xx stops Paddle (applied,
 * a duplicate, or not ours), 401 is a forged or mis-signed request, 5xx asks
 * for a retry -- settings missing, the database unreachable, or a buyer we
 * cannot place yet; the transaction rolled back and nothing was recorded.
 */
import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { PaddleNotConfigured } from '@/lib/infra/paddle';
import { receivePaddleWebhook, RetryLater, WebhookRejected } from '@/lib/services/billing';

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  try {
    const outcome = await receivePaddleWebhook(rawBody, request.headers.get('paddle-signature'));
    return json({ outcome });
  } catch (error) {
    if (error instanceof WebhookRejected) return fail('invalid_signature', 401);
    if (error instanceof PaddleNotConfigured) return fail('not_configured', 503);
    if (error instanceof RetryLater) {
      console.warn('paddle webhook deferred', error.message);
      return fail('retry', 503);
    }
    console.error('paddle webhook failed', (error as Error).message);
    return fail('retry', 500);
  }
}
