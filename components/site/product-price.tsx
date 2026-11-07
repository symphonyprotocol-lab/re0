import type { PriceView } from '@/lib/domain/pricing';
import { fill, formatNumber, formatUsd } from '@/i18n/format';
import type { Messages, Locale } from '@/i18n';

type PriceProps = { price: PriceView; kind: 'plan' | 'pack'; locale: Locale; labels: Messages['site']['prices'] };

export function ProductPrice({ price, locale }: PriceProps) {
  return (
    <span>
      {formatUsd(price.effectivePriceMinor, locale)}
      {price.promotional && (
        <>
          {' '}
          <del className="text-sm text-muted font-normal">{formatUsd(price.priceMinor, locale)}</del>
        </>
      )}
    </span>
  );
}

export function PromotionNotice({ price, kind, locale, labels }: PriceProps) {
  if (!price.promotional) return null;
  return (
    <span className="block text-xs text-blue font-normal">
      {labels.promotion}{' '}
      {kind === 'plan' ? fill(labels.planPromotion, { price: formatUsd(price.priceMinor, locale) }) : labels.packPromotion}
    </span>
  );
}

export function pricingFaqValues(prices: { plan: PriceView; pack: PriceView }, locale: Locale, labels: Messages['site']['prices']) {
  return {
    planPrice: formatUsd(prices.plan.effectivePriceMinor, locale),
    packPrice: formatUsd(prices.pack.effectivePriceMinor, locale),
    planCredits: formatNumber(prices.plan.credits, locale),
    packCredits: formatNumber(prices.pack.credits, locale),
    planPromotion: prices.plan.promotional ? fill(labels.planPromotion, { price: formatUsd(prices.plan.priceMinor, locale) }) : '',
  };
}
