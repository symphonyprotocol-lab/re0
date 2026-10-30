/**
 * The channel-commerce settings the console owns (agent-first-proposal.md
 * 6.9, 13.2), and the spans they may be set within.
 *
 * Four numbers decide what a channel subscription costs and when its money
 * may leave: the least any one transaction may charge, the platform's fee on
 * new plan versions, how long a statement is held against chargebacks, and
 * the least a cash payout may carry. They are settings rather than constants
 * because the fee basis Paddle charges on is still being confirmed (13.2
 * item 4): if the fee turns out to fall on the tax-inclusive total, the
 * minimum goes up, and that must not wait for a deploy.
 *
 * Pure TypeScript -- domain layer rules apply.
 */
import { PAYOUT_HOLD_DAYS, PAYOUT_THRESHOLD_MINOR } from './index';

export const COMMERCE_SETTING_KEYS = ['minPriceMinor', 'feeRateBps', 'payoutHoldDays', 'payoutThresholdMinor'] as const;

export type CommerceSettingKey = (typeof COMMERCE_SETTING_KEYS)[number];

export type CommerceSettings = Record<CommerceSettingKey, number>;

/**
 * $5.00 a transaction, monthly or yearly alike (proposal 6.9: break-even at
 * Paddle's 5% + $0.50 is about $3.34 per transaction, whatever the period);
 * 20% to the platform; 120 days of hold; $20 for a PayPal payout.
 */
export const DEFAULT_COMMERCE_SETTINGS: CommerceSettings = {
  minPriceMinor: 500,
  feeRateBps: 2_000,
  payoutHoldDays: PAYOUT_HOLD_DAYS,
  payoutThresholdMinor: PAYOUT_THRESHOLD_MINOR,
};

export const COMMERCE_SETTING_BOUNDS: Record<CommerceSettingKey, { min: number; max: number }> = {
  /* Below $1 every transaction loses money on the fixed fee alone. */
  minPriceMinor: { min: 100, max: 100_000 },
  feeRateBps: { min: 0, max: 5_000 },
  payoutHoldDays: { min: 0, max: 365 },
  payoutThresholdMinor: { min: 0, max: 100_000 },
};

export class CommerceConfigRefused extends Error {
  constructor(
    readonly key: CommerceSettingKey,
    message: string,
  ) {
    super(message);
    this.name = 'CommerceConfigRefused';
  }
}

/** Every key present, an integer, inside its span; anything else is refused, never defaulted. */
export function validateCommerceSettings(values: Partial<Record<CommerceSettingKey, number>>): CommerceSettings {
  const settings = {} as CommerceSettings;
  for (const key of COMMERCE_SETTING_KEYS) {
    const value = values[key];
    const bounds = COMMERCE_SETTING_BOUNDS[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      throw new CommerceConfigRefused(key, `${key} must be an integer from ${bounds.min} to ${bounds.max}`);
    }
    settings[key] = value;
  }
  return settings;
}
