'use client';

import { useI18n } from '@/i18n/client';
import { formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';

/** Shared answer and feedback figures for discovery and the owner's cards. */
export function ReeCardMetrics({ answers, positiveRate }: { answers: number; positiveRate: number | null }) {
  const { t, locale } = useI18n();
  const c = t.discover.card;
  return (
    <div className="discovery-card-metrics" role="group" aria-label={c.activity}>
      <span title={c.answers}>
        <strong><Icon name="chat" />{formatNumber(answers, locale)}</strong>
        <span className="sr-only">{c.answers}</span>
      </span>
      <span title={c.rating}>
        <strong>
          <Icon name="thumbUp" />
          {positiveRate === null ? <span className="discovery-rating-empty">{c.noRating}</span> : `${positiveRate}%`}
        </strong>
        <span className="sr-only">{c.rating}</span>
      </span>
    </div>
  );
}
