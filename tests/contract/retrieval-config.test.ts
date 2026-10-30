/**
 * Retrieval's tunables, as rules. architecture.md 9.3, 9.5, 9.6.
 *
 * Two things a published configuration depends on: that the defaults are the
 * constants retrieval ran with before the console could change them (an
 * installation that never saves must behave exactly as it did), and that a
 * refusal names the knob and the span, because the console repeats both to
 * the operator.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRIEVAL_SETTINGS,
  RETRIEVAL_SETTING_BOUNDS,
  RETRIEVAL_SETTING_KEYS,
  RetrievalConfigRefused,
  retrievalBudgetFor,
  validateRetrievalSettings,
} from '@/lib/domain/retrieval-config';

describe('defaults', () => {
  it('are the constants retrieval shipped with', () => {
    expect(DEFAULT_RETRIEVAL_SETTINGS).toEqual({
      recallLimit: 50,
      rrfK: 60,
      rerankWindow: 30,
      rerankDocumentChars: 1_500,
      cacheTtlSeconds: 21_600,
      playgroundTokensDefault: 4_000,
      playgroundTokensMax: 6_000,
      routingRecallLimit: 24,
      routingRareSampleCap: 400,
      routingResultLimit: 10,
      playgroundAgent: 0,
      playgroundAgentSteps: 4,
      playgroundAgentQueries: 3,
      playgroundAgentResolves: 2,
      /* The channel directory's 热门 weights and half-life (agent-first-proposal.md 6.4). */
      channelActivityBps: 5_000,
      channelFreshnessBps: 2_500,
      channelQualityBps: 2_500,
      channelHalfLifeDays: 14,
      /* A2A `ask` (agent-first-proposal.md 8.2). */
      askCallsPerAnswer: 10,
      askDailyAnswers: 500,
    });
  });

  it('sit inside their own bounds, so the defaults are always saveable', () => {
    expect(validateRetrievalSettings(DEFAULT_RETRIEVAL_SETTINGS)).toEqual(DEFAULT_RETRIEVAL_SETTINGS);
    for (const key of RETRIEVAL_SETTING_KEYS) {
      const { min, max, default: value } = RETRIEVAL_SETTING_BOUNDS[key];
      expect(value).toBeGreaterThanOrEqual(min);
      expect(value).toBeLessThanOrEqual(max);
    }
  });
});

describe('validation', () => {
  const refusal = (input: Partial<typeof DEFAULT_RETRIEVAL_SETTINGS>) => {
    try {
      validateRetrievalSettings({ ...DEFAULT_RETRIEVAL_SETTINGS, ...input });
      return null;
    } catch (error) {
      return error instanceof RetrievalConfigRefused ? { field: error.field, code: error.code } : 'unexpected';
    }
  };

  it('refuses a value outside its span, naming the field', () => {
    expect(refusal({ recallLimit: 0 })).toEqual({ field: 'recallLimit', code: 'out_of_range' });
    expect(refusal({ recallLimit: 10_000 })).toEqual({ field: 'recallLimit', code: 'out_of_range' });
    expect(refusal({ cacheTtlSeconds: -1 })).toEqual({ field: 'cacheTtlSeconds', code: 'out_of_range' });
    /* Zero is a legal TTL: it is how the cache is switched off. */
    expect(refusal({ cacheTtlSeconds: 0 })).toBeNull();
  });

  it('refuses a blank or fractional field rather than defaulting it', () => {
    expect(refusal({ rrfK: Number.NaN })).toEqual({ field: 'rrfK', code: 'out_of_range' });
    expect(refusal({ rrfK: 60.5 })).toEqual({ field: 'rrfK', code: 'out_of_range' });
    const missing = { ...DEFAULT_RETRIEVAL_SETTINGS } as Partial<typeof DEFAULT_RETRIEVAL_SETTINGS>;
    delete missing.rerankWindow;
    expect(() => validateRetrievalSettings(missing)).toThrow(RetrievalConfigRefused);
  });

  it('refuses the two pairs that cannot both apply', () => {
    expect(refusal({ playgroundTokensDefault: 20_000, playgroundTokensMax: 16_000 })).toEqual({
      field: 'playgroundTokensDefault',
      code: 'inconsistent',
    });
    expect(refusal({ routingResultLimit: 30, routingRecallLimit: 24 })).toEqual({
      field: 'routingResultLimit',
      code: 'inconsistent',
    });
  });
});

describe('the playground budget', () => {
  const limits = { playgroundTokensDefault: 4_000, playgroundTokensMax: 16_000 };

  it('spends the window minus the room the rest of the prompt needs', () => {
    expect(retrievalBudgetFor(8_000, limits)).toBe(6_800);
  });

  it('caps a large window at the configured maximum, and floors a tiny one', () => {
    expect(retrievalBudgetFor(2_000_000, limits)).toBe(16_000);
    expect(retrievalBudgetFor(128_000, limits)).toBe(16_000);
    expect(retrievalBudgetFor(128_000, { ...limits, playgroundTokensMax: 12_000 })).toBe(12_000);
    expect(retrievalBudgetFor(1_000, limits)).toBe(256);
  });

  it('uses the configured default when no model is configured', () => {
    expect(retrievalBudgetFor(undefined, limits)).toBe(4_000);
    expect(retrievalBudgetFor(undefined, { ...limits, playgroundTokensDefault: 2_000 })).toBe(2_000);
  });
});
