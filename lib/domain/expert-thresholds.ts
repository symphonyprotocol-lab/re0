/**
 * The thresholds an expert-library application is judged by, as pure
 * rules. review-visibility-proposal.md 5.3; the gate itself is
 * lib/domain/expert-library.ts `expertEvalReady`.
 *
 * These used to sit among the public-review rules; they outlived them
 * (2026-10-23) because the expert tag keeps an approval. Kept with a
 * history like retrieval's tunables: a save mints a row, the newest is in
 * force, and an empty table means the defaults.
 */

export const EXPERT_THRESHOLD_KEYS = ['expertMinQuestions', 'expertHitRateMin'] as const;

export type ExpertThresholdKey = (typeof EXPERT_THRESHOLD_KEYS)[number];

export type ExpertThresholds = Record<ExpertThresholdKey, number>;

export interface ExpertThresholdBounds {
  min: number;
  max: number;
  default: number;
}

export const EXPERT_THRESHOLD_BOUNDS: Record<ExpertThresholdKey, ExpertThresholdBounds> = {
  /** Questions a library needs before applying for the expert tag; 0 waives the gate. */
  expertMinQuestions: { min: 0, max: 50, default: 10 },
  /** Share of them, 0-100, the current version must answer for the application to open. */
  expertHitRateMin: { min: 0, max: 100, default: 70 },
};

export const DEFAULT_EXPERT_THRESHOLDS: ExpertThresholds = Object.fromEntries(
  EXPERT_THRESHOLD_KEYS.map((key) => [key, EXPERT_THRESHOLD_BOUNDS[key].default]),
) as ExpertThresholds;

export class ExpertThresholdsRefused extends Error {
  constructor(
    readonly code: 'out_of_range',
    readonly field: ExpertThresholdKey,
    message: string,
  ) {
    super(message);
    this.name = 'ExpertThresholdsRefused';
  }
}

/** Every key, each an integer within its bounds; a missing one is refused, never defaulted. */
export function validateExpertThresholds(values: Partial<Record<ExpertThresholdKey, number>>): ExpertThresholds {
  const thresholds = {} as ExpertThresholds;
  for (const key of EXPERT_THRESHOLD_KEYS) {
    const value = values[key];
    const bounds = EXPERT_THRESHOLD_BOUNDS[key];
    if (value === undefined || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      throw new ExpertThresholdsRefused('out_of_range', key, `${key} must be an integer in ${bounds.min}..${bounds.max}`);
    }
    thresholds[key] = value;
  }
  return thresholds;
}
