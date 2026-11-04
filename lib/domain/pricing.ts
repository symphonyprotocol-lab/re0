import { PACK, PLAN } from '@/lib/constants';
import type { PurchaseKind } from '@/lib/domain/billing';

export interface PriceSettings {
  priceMinor: number;
  promotion: { priceMinor: number; startsAt: string; endsAt: string } | null;
}
export interface PriceView extends PriceSettings {
  revision: string;
  effectivePriceMinor: number;
  promotional: boolean;
  quoteKey: string;
}
export type PricingView = Record<PurchaseKind, PriceView>;

export function priceView(settings: PriceSettings, revision: string, now = new Date()): PriceView {
  const promo = settings.promotion;
  const promotional = Boolean(promo && Date.parse(promo.startsAt) <= now.getTime() && now.getTime() < Date.parse(promo.endsAt));
  return {
    ...settings,
    revision,
    promotional,
    effectivePriceMinor: promotional ? promo!.priceMinor : settings.priceMinor,
    quoteKey: `${revision}:${promotional ? 'promotion' : 'regular'}`,
  };
}

export function defaultPrice(kind: PurchaseKind, now = new Date()): PriceView {
  return priceView({ priceMinor: (kind === 'plan' ? PLAN : PACK).priceMinor, promotion: null }, 'default', now);
}

/** Currency is USD cents; reject rounding, partial dates and non-discount promotions. */
export function parsePriceSettings(raw: Record<string, unknown>): PriceSettings | null {
  const validAmount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 100_000_000;
  if (!validAmount(raw.priceMinor)) return null;
  if (raw.promotion === null) return { priceMinor: raw.priceMinor, promotion: null };
  if (!raw.promotion || typeof raw.promotion !== 'object' || Array.isArray(raw.promotion)) return null;
  const p = raw.promotion as Record<string, unknown>;
  const date = (s: unknown): s is string =>
    typeof s === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s) &&
    Number.isFinite(Date.parse(s));
  if (
    !validAmount(p.priceMinor) ||
    p.priceMinor >= raw.priceMinor ||
    !date(p.startsAt) ||
    !date(p.endsAt) ||
    Date.parse(p.startsAt) >= Date.parse(p.endsAt)
  )
    return null;
  return {
    priceMinor: raw.priceMinor,
    promotion: { priceMinor: p.priceMinor, startsAt: new Date(p.startsAt).toISOString(), endsAt: new Date(p.endsAt).toISOString() },
  };
}

export interface WelcomeCreditsView {
  credits: number;
  revision: string;
}

export function validWelcomeCredits(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
}
