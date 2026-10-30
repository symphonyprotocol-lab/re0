/**
 * Pure rules the follow-up review of the P1-P5 fixes tightened
 * (docs/reviews/agent-first-p1-p5-review.md).
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '@/contracts/errors';
import { publicationRefusal } from '@/lib/application/editorial/assets';
import { EditorialRefused } from '@/lib/domain/editorial';
import { ChannelCommerceRefused, channelSaleMismatch } from '@/lib/domain/channel-commerce';

describe('a scheduled publication: refused by a rule, or failed on our side', () => {
  it('unschedules for a rule and keeps the draft scheduled for a failure of ours', () => {
    expect(publicationRefusal(new ChannelCommerceRefused('subscriptions_disabled', 'x'))).toBe('subscriptions_disabled');
    expect(publicationRefusal(new EditorialRefused('no_audio', 'x'))).toBe('no_audio');
    /* A build the workspace cannot afford is a rule: retrying every drain would refuse every time. */
    expect(publicationRefusal(new AppError('quota_exceeded', 'x'))).toBe('quota_exceeded');
    for (const code of ['internal_error', 'provider_unavailable', 'rate_limited', 'source_fetch_failed', 'index_failed'] as const) {
      expect(publicationRefusal(new AppError(code, 'x'))).toBeNull();
    }
    expect(publicationRefusal(new Error('connection reset'))).toBeNull();
  });
});

describe('a channel sale against its plan version', () => {
  const plan = { priceMinor: 600, currency: 'USD' };
  const sale = { onChannelProduct: true, currency: 'USD', listPriceMinor: 600, discountMinor: 0 };
  it('holds a first sale to the amount, and a renewal only to the product and currency', () => {
    expect(channelSaleMismatch({ ...sale, discountMinor: 300 }, plan)).toBe('amount');
    expect(channelSaleMismatch({ ...sale, discountMinor: 300 }, plan, { renewal: true })).toBeNull();
    expect(channelSaleMismatch({ ...sale, listPriceMinor: 1 }, plan, { renewal: true })).toBeNull();
    expect(channelSaleMismatch({ ...sale, currency: 'JPY' }, plan, { renewal: true })).toBe('currency');
    expect(channelSaleMismatch({ ...sale, onChannelProduct: false }, plan, { renewal: true })).toBe('product');
  });
});
