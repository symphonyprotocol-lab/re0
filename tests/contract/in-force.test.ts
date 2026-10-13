/**
 * The billing window of the subscription in force. The row selection itself is
 * SQL and is covered against Postgres in tests/integration/payment-webhook.
 */
import { describe, expect, it } from 'vitest';
import { RENEWAL_GRACE_MS, windowInForce } from '@/lib/application/plans/in-force';

const START = new Date('2026-09-02T10:00:00Z');
const END = new Date('2026-10-02T10:00:00Z');

describe('windowInForce', () => {
  it('is the row’s own period while that period runs', () => {
    expect(windowInForce({ periodStart: START, periodEnd: END }, new Date('2026-09-20T00:00:00Z'))).toEqual({
      periodStart: START,
      periodEnd: END,
    });
  });

  it('starts the next period at the old end during the renewal grace', () => {
    const window = windowInForce({ periodStart: START, periodEnd: END }, new Date(END.getTime() + 60_000));
    expect(window.periodStart).toEqual(END);
    expect(window.periodEnd).toEqual(new Date(END.getTime() + RENEWAL_GRACE_MS));
  });
});
