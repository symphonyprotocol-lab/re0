/**
 * Replays real Paddle sandbox notifications into a local server, signed with
 * PADDLE_WEBHOOK_SECRET exactly as Paddle signs them. For local work where
 * Paddle cannot reach `localhost` (no tunnel): pay in the sandbox overlay,
 * then fetch what Paddle recorded and post it to `/api/billing/paddle`.
 *
 *   npm run paddle:replay -- --since=2026-11-02T06:00:00Z [--target=http://localhost:3300] [--dry-run]
 *   npm run paddle:replay -- --ids=evt_01…,evt_01…
 *
 * Only the sandbox, only to a loopback target, only transaction /
 * subscription / adjustment events, oldest first. The webhook is idempotent
 * by event id, so running it twice changes nothing.
 */
import nextEnv from '@next/env';
import { createHmac } from 'node:crypto';

nextEnv.loadEnvConfig(process.cwd());

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    return [key, rest.join('=') || 'true'];
  }),
);

const apiKey = process.env.PADDLE_API_KEY;
const secret = process.env.PADDLE_WEBHOOK_SECRET;
if (process.env.PADDLE_ENVIRONMENT !== 'sandbox' || !apiKey || !secret) {
  console.error('needs PADDLE_ENVIRONMENT=sandbox, PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET');
  process.exit(1);
}
const target = new URL('/api/billing/paddle', args.target ?? process.env.APP_BASE_URL ?? 'http://localhost:3000');
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
  console.error(`refusing to post to ${target.origin}: loopback only`);
  process.exit(1);
}

interface PaddleEvent {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

/** Newest first, page after page, until the events are older than `since`, every wanted id is found, or Paddle has no more. */
async function listEvents(since: Date, ids: Set<string> | null): Promise<PaddleEvent[]> {
  const events: PaddleEvent[] = [];
  let url: string | null = 'https://sandbox-api.paddle.com/events?per_page=200&order_by=id%5BDESC%5D';
  for (let page = 0; url && page < 50; page += 1) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const body = (await response.json()) as { data?: PaddleEvent[]; meta?: { pagination?: { next?: string; has_more?: boolean } }; error?: { detail?: string } };
    if (!response.ok || !body.data) throw new Error(`paddle /events: ${response.status} ${body.error?.detail ?? ''}`);
    events.push(...body.data);
    const oldest = body.data.at(-1);
    if (ids && [...ids].every((id) => events.some((event) => event.event_id === id))) break;
    if (!body.meta?.pagination?.has_more || !oldest || new Date(oldest.occurred_at) < since) break;
    url = body.meta.pagination.next ?? null;
  }
  return events;
}

const wanted = /^(transaction|subscription|adjustment)\./;
const ids = args.ids ? new Set<string>(String(args.ids).split(',')) : null;
const since = args.since ? new Date(args.since) : new Date(Date.now() - 60 * 60 * 1000);
/* Picking events by id: look back as far as the cursor goes unless --since says otherwise. */
const events = (await listEvents(ids && !args.since ? new Date(0) : since, ids))
  .filter((event) => wanted.test(event.event_type))
  .filter((event) => (ids ? ids.has(event.event_id) : new Date(event.occurred_at) >= since))
  .reverse();

for (const event of events) {
  const raw = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const signature = `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:${raw}`, 'utf8').digest('hex')}`;
  if (args['dry-run']) {
    console.log(event.event_id, event.event_type);
    continue;
  }
  const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': signature }, body: raw });
  console.log(event.event_id, event.event_type, response.status, await response.text());
}
console.log(`${events.length} event(s)`);
