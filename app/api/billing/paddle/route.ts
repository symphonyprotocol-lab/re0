/**
 * POST /api/billing/paddle -- Paddle's webhook destination. architecture.md 11.3.
 *
 * The body is read as text and handed over untouched: the signature is over
 * the exact bytes Paddle sent, and parsing first would verify a re-serialised
 * copy instead.
 *
 * The status codes are the retry policy. A 2xx tells Paddle to stop, which is
 * right for everything the use case returns -- including notifications it
 * recorded but could not place, which would fail the same way on every retry.
 * A 401 is a forged or mis-signed request. A 5xx is reserved for "try again":
 * the settings are missing, or the database or Paddle's API was unreachable,
 * the transaction rolled back, and the event is still unprocessed.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { receivePaymentWebhook } from '@/lib/application/billing';
import { PaymentNotConfigured, WebhookRejected } from '@/lib/infrastructure/payment/provider';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();
  try {
    const outcome = await receivePaymentWebhook(rawBody, request.headers.get('paddle-signature'));
    return NextResponse.json({ outcome });
  } catch (error) {
    if (error instanceof WebhookRejected) {
      return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
    }
    /*
     * Settings missing is still "try again": a deployment whose secret was
     * dropped in a bad release should catch up once it is restored, not lose
     * every payment made in between.
     */
    if (error instanceof PaymentNotConfigured) {
      return NextResponse.json({ error: 'not_configured' }, { status: 503 });
    }
    console.error('payment webhook failed', (error as Error).message);
    return NextResponse.json({ error: 'retry' }, { status: 500 });
  }
}
