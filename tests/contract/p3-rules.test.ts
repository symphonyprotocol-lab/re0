/**
 * The P3 rules that need no database (agent-first-proposal.md 6.5-6.9):
 * plan prices and the per-transaction minimum, the creator's share, access
 * by period end, who may read and write comments, what an article or an
 * episode indexes, feed parsing, the commerce settings' spans, and the
 * Paddle channel notices.
 */
import { describe, expect, it } from 'vitest';
import {
  assertSellablePrice,
  ChannelCommerceRefused,
  channelSaleMismatch,
  creatorShareBps,
  creatorShareMinor,
  grantsAccess,
  planPriceMinor,
  statementsWithinBalance,
} from '@/lib/domain/channel-commerce';
import { CommerceConfigRefused, DEFAULT_COMMERCE_SETTINGS, validateCommerceSettings } from '@/lib/domain/commerce-config';
import { commentPieces, mayReadComments, mayWriteComment, normalizeCommentBody } from '@/lib/domain/comment';
import {
  audioContentType,
  editorialPublicId,
  episodeDocument,
  indexedBody,
  parseFeed,
  postDocument,
  publishInstant,
  qaDocument,
  referencedMedia,
} from '@/lib/domain/editorial';
import { channelSubscriptionNotice, channelTransactionNotice, isChannelTransaction, type PaddleTransaction } from '@/lib/infrastructure/payment/paddle';

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as ChannelCommerceRefused).code;
  }
  return 'ok';
}

describe('channel plans and the creator share', () => {
  it('reads dollar prices and refuses anything under the minimum, whatever the interval', () => {
    expect(planPriceMinor('5', 500)).toBe(500);
    expect(planPriceMinor('4.99', 400)).toBe(499);
    expect(planPriceMinor('60', 500)).toBe(6_000);
    expect(refusal(() => planPriceMinor('4.99', 500))).toBe('below_minimum');
    expect(refusal(() => planPriceMinor('5.001', 500))).toBe('invalid_price');
    expect(refusal(() => planPriceMinor('-5', 500))).toBe('invalid_price');
    expect(refusal(() => assertSellablePrice(499, 500))).toBe('below_minimum');
  });

  it('credits 80% of the ex-tax amount and takes back the same on a full refund', () => {
    const share = creatorShareBps(2_000);
    expect(share).toBe(8_000);
    expect(creatorShareMinor(600, share)).toBe(480);
    expect(creatorShareMinor(-600, share)).toBe(-480);
    expect(creatorShareMinor(333, share) + creatorShareMinor(-333, share)).toBe(0);
  });

  it('grants access while the period runs, after a cancellation too, and never after a refund', () => {
    const now = new Date('2026-10-30T00:00:00Z');
    const later = new Date('2026-11-30T00:00:00Z');
    const earlier = new Date('2026-10-29T23:59:59Z');
    expect(grantsAccess({ status: 'active', currentPeriodEnd: later }, now)).toBe(true);
    expect(grantsAccess({ status: 'canceled', currentPeriodEnd: later }, now)).toBe(true);
    expect(grantsAccess({ status: 'active', currentPeriodEnd: earlier }, now)).toBe(false);
    expect(grantsAccess({ status: 'refunded', currentPeriodEnd: later }, now)).toBe(false);
    expect(grantsAccess({ status: 'paused', currentPeriodEnd: later }, now)).toBe(false);
  });

  it('takes whole statements, oldest first, only as far as the balance reaches (review H4)', () => {
    const jan = { periodId: '2026-01', amountMinor: 4_800 };
    const feb = { periodId: '2026-02', amountMinor: 4_800 };
    const mar = { periodId: '2026-03', amountMinor: -480 };
    /* A chargeback of January booked in an open month: the balance is 4,800, not 9,600. */
    expect(statementsWithinBalance([feb, jan], 4_800)).toEqual([jan]);
    expect(statementsWithinBalance([feb, jan], 9_600)).toEqual([jan, feb]);
    expect(statementsWithinBalance([jan, feb], 0)).toEqual([]);
    /* A negative statement always goes: it nets against what is paid, and lets more fit. */
    expect(statementsWithinBalance([jan, feb, mar], 4_320)).toEqual([mar, jan]);
    expect(statementsWithinBalance([jan, mar], 0)).toEqual([mar]);
  });

  it('accepts a channel sale only on the channel product, in the plan currency, at the plan price, undiscounted (review M15)', () => {
    const plan = { priceMinor: 600, currency: 'USD' };
    const sale = { onChannelProduct: true, currency: 'USD', listPriceMinor: 600, discountMinor: 0 };
    expect(channelSaleMismatch(sale, plan)).toBeNull();
    expect(channelSaleMismatch({ ...sale, onChannelProduct: false }, plan)).toBe('product');
    expect(channelSaleMismatch({ ...sale, currency: 'JPY' }, plan)).toBe('currency');
    expect(channelSaleMismatch({ ...sale, listPriceMinor: 599 }, plan)).toBe('amount');
    expect(channelSaleMismatch({ ...sale, listPriceMinor: Number.NaN }, plan)).toBe('amount');
    expect(channelSaleMismatch({ ...sale, discountMinor: 100 }, plan)).toBe('amount');
  });

  it('holds the console settings to their spans', () => {
    expect(validateCommerceSettings(DEFAULT_COMMERCE_SETTINGS)).toEqual({ minPriceMinor: 500, feeRateBps: 2_000, payoutHoldDays: 120, payoutThresholdMinor: 2_000 });
    expect(() => validateCommerceSettings({ ...DEFAULT_COMMERCE_SETTINGS, minPriceMinor: 50 })).toThrow(CommerceConfigRefused);
    expect(() => validateCommerceSettings({ ...DEFAULT_COMMERCE_SETTINGS, feeRateBps: Number.NaN })).toThrow(CommerceConfigRefused);
  });
});

describe('comments', () => {
  const publicChannel = { visibility: 'public' as const, status: 'active' as const };
  const stranger = { signedIn: true, isOwner: false, isSubscriber: false };
  const anonymous = { signedIn: false, isOwner: false, isSubscriber: false };
  const subscriber = { signedIn: true, isOwner: false, isSubscriber: true };
  const owner = { signedIn: true, isOwner: true, isSubscriber: false };

  it('opens free assets to every signed-in reader and paid ones to subscribers and the creator', () => {
    const free = { channel: publicChannel, access: 'free' as const, commentsClosed: false };
    const paid = { channel: publicChannel, access: 'paid' as const, commentsClosed: false };
    expect(mayReadComments(free, anonymous)).toBe(true);
    expect(mayWriteComment(free, anonymous)).toBe(false);
    expect(mayWriteComment(free, stranger)).toBe(true);
    expect(mayReadComments(paid, stranger)).toBe(false);
    expect(mayWriteComment(paid, stranger)).toBe(false);
    expect(mayWriteComment(paid, subscriber)).toBe(true);
    expect(mayReadComments(paid, owner)).toBe(true);
  });

  it('has no comments outside a public channel, and closed ones stop everyone but the creator', () => {
    for (const channel of [null, { visibility: 'private' as const, status: 'active' as const }, { visibility: 'public' as const, status: 'suspended' as const }]) {
      expect(mayReadComments({ channel, access: 'free', commentsClosed: false }, owner)).toBe(false);
    }
    const closed = { channel: publicChannel, access: 'free' as const, commentsClosed: true };
    expect(mayWriteComment(closed, stranger)).toBe(false);
    expect(mayWriteComment(closed, owner)).toBe(true);
  });

  it('keeps a body plain: links become link pieces, markup stays text', () => {
    expect(normalizeCommentBody('  hi\u0000 there ')).toBe('hi there');
    const pieces = commentPieces('see https://example.test/a. <script>alert(1)</script>');
    expect(pieces).toContainEqual({ kind: 'link', href: 'https://example.test/a', text: 'https://example.test/a' });
    expect(pieces.filter((piece) => piece.kind === 'text').map((piece) => piece.text).join('')).toContain('<script>');
    expect(commentPieces('javascript:alert(1)').every((piece) => piece.kind === 'text')).toBe(true);
  });
});

describe('what articles, episodes and Q&As index', () => {
  const imageId = '01920000-0000-7000-8000-00000000aaaa';

  it('replaces each image by its caption and never by its bytes', () => {
    const body = `Intro\n\n![a heron](media:${imageId})\n\n![](https://tracker.example/pixel.gif)`;
    expect(referencedMedia(body)).toEqual([imageId]);
    expect(indexedBody(body, new Map([[imageId, 'Grey heron at dawn']]))).toContain('[Image: Grey heron at dawn]');
    expect(indexedBody(body)).toContain('[Image: a heron]');
    expect(indexedBody(body)).not.toContain('tracker.example');
    expect(postDocument({ title: 'Herons', summary: 'Birds', body: 'Text' })).toBe('# Herons\n\nBirds\n\nText\n');
  });

  it('indexes an episode by its title and notes, and a Q&A by question and answer only', () => {
    expect(episodeDocument({ title: 'Ep 1', notes: 'We talk about herons.' })).toBe('# Ep 1\n\nWe talk about herons.\n');
    expect(qaDocument({ question: 'Why?', answer: 'Because.' })).toBe('# Why?\n\nBecause.\n');
    expect(editorialPublicId('audio', 'ada', 'ep-1')).toBe('/audio/ada/ep-1');
    expect(audioContentType('', 'show.M4A')).toBe('audio/mp4');
    expect(audioContentType('audio/mp3', 'x')).toBe('audio/mpeg');
    expect(audioContentType('video/mp4', 'x.mp4')).toBeNull();
  });

  it('schedules ahead, publishes now for a past time, and refuses more than a year out', () => {
    const now = new Date('2026-10-30T00:00:00Z');
    expect(publishInstant('', now)).toBeNull();
    expect(publishInstant('2026-10-29T00:00', now)).toBeNull();
    expect(publishInstant('2026-11-02T09:00Z', now)?.toISOString()).toBe('2026-11-02T09:00:00.000Z');
    expect(() => publishInstant('2028-01-01T00:00Z', now)).toThrow();
  });

  it('reads RSS and Atom items, one draft each', () => {
    const rss = `<?xml version="1.0"?><rss><channel><item><title>First &amp; best</title><link>https://ex.test/1</link><description><![CDATA[<p>Hello</p>]]></description></item><item><title>Second</title></item></channel></rss>`;
    expect(parseFeed(rss)).toMatchObject([{ title: 'First & best', link: 'https://ex.test/1', content: '<p>Hello</p>' }, { title: 'Second' }]);
    const atom = `<feed><entry><title>Atom one</title><link href="https://ex.test/a"/><content>Body</content></entry></feed>`;
    expect(parseFeed(atom)).toMatchObject([{ title: 'Atom one', link: 'https://ex.test/a', content: 'Body' }]);
  });
});

describe('Paddle channel notices', () => {
  const plan = '01920000-0000-7000-8000-0000000000aa';
  const user = '01920000-0000-7000-8000-0000000000bb';
  const workspace = '01920000-0000-7000-8000-0000000000cc';
  const transaction: PaddleTransaction = {
    id: 'txn_1',
    status: 'completed',
    customer_id: 'ctm_1',
    subscription_id: 'sub_1',
    invoice_number: null,
    currency_code: 'USD',
    custom_data: { re0_kind: 'channel', re0_channel_plan_version_id: plan, re0_user_id: user, re0_workspace_id: workspace },
    billing_period: { starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z' },
    billed_at: '2026-10-01T00:00:00Z',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:01:00Z',
    items: [{ quantity: 1, price: { product_id: 'pro_channel', unit_price: { amount: '600', currency_code: 'USD' } } }],
    details: { totals: { grand_total: '720', subtotal: '600', discount: '0', tax: '120', total: '720' } },
    payments: [{ status: 'captured', captured_at: '2026-10-01T00:00:30Z', method_details: { type: 'card' } }],
  };

  it('reads the ex-tax amount, the subscriber and the period from a channel transaction', () => {
    expect(isChannelTransaction(transaction, null)).toBe(true);
    expect(isChannelTransaction({ ...transaction, custom_data: null }, 'pro_channel')).toBe(true);
    expect(isChannelTransaction({ ...transaction, custom_data: null }, null)).toBe(false);
    const notice = channelTransactionNotice(transaction, [
      { id: 'adj_1', transaction_id: 'txn_1', action: 'chargeback', status: 'approved', totals: { total: '720', subtotal: '600', tax: '120' }, updated_at: '2026-12-01T00:00:00Z' },
      { id: 'adj_x', transaction_id: 'txn_other', action: 'refund', status: 'approved', totals: { total: '1' }, updated_at: '2026-12-01T00:00:00Z' },
    ], 'pro_channel');
    expect(notice).toMatchObject({ state: 'collected', exTaxMinor: 600, channelPlanVersionId: plan, userId: user, workspaceId: workspace });
    /* What was sold, for the ledger to hold against the plan version (review M15). */
    expect(notice).toMatchObject({ onChannelProduct: true, currency: 'USD', listPriceMinor: 600, discountMinor: 0 });
    expect(notice.periodEnd?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(notice.adjustments).toEqual([expect.objectContaining({ id: 'adj_1', action: 'chargeback', exTaxMinor: 600 })]);
  });

  it('reports a tagged transaction for another product, or a cheaper or discounted one, as such (review M15)', () => {
    const other = channelTransactionNotice(
      { ...transaction, currency_code: 'JPY', items: [{ quantity: 1, price: { product_id: 'pro_some_catalogue', unit_price: { amount: '1', currency_code: 'JPY' } } }] },
      [],
      'pro_channel',
    );
    expect(other).toMatchObject({ onChannelProduct: false, currency: 'JPY', listPriceMinor: 1 });
    /* No channel product configured: nothing is on it. */
    expect(channelTransactionNotice(transaction, [], null).onChannelProduct).toBe(false);
    const discounted = channelTransactionNotice(
      { ...transaction, details: { totals: { grand_total: '360', subtotal: '600', discount: '300', tax: '60', total: '360' } } },
      [],
      'pro_channel',
    );
    expect(discounted).toMatchObject({ listPriceMinor: 600, discountMinor: 300, exTaxMinor: 300 });
    /* A price without an amount, or in another currency than the transaction, is not a price at all. */
    expect(channelTransactionNotice({ ...transaction, items: [{ quantity: 1, price: { product_id: 'pro_channel' } }] }, [], 'pro_channel').listPriceMinor).toBeNaN();
  });

  it('reads a scheduled cancellation from a subscription event', () => {
    const notice = channelSubscriptionNotice({
      id: 'sub_1',
      status: 'active',
      customer_id: 'ctm_1',
      custom_data: { re0_kind: 'channel' },
      current_billing_period: { starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z' },
      scheduled_change: { action: 'cancel', effective_at: '2026-11-01T00:00:00Z' },
      items: null,
      updated_at: '2026-10-15T00:00:00Z',
    });
    expect(notice).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
  });
});
