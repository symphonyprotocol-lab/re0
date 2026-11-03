'use client';

import { useId, useState } from 'react';
import { CREDIT_USD, ESTIMATOR, PLAN, QUERY_BASE_FEE } from '@/lib/constants';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber, formatUsd } from '@/i18n/format';

/** The pricing page's slider (prototype `.pricing-estimator`, `#question-range`): answers on your own Ree, in credits and dollars. */
export function Estimator() {
  const { t, locale } = useI18n();
  const e = t.site.pricing.estimator;
  const id = useId();
  const [answers, setAnswers] = useState<number>(ESTIMATOR.default);
  const credits = answers * QUERY_BASE_FEE;
  const usd = formatUsd(Math.round(credits * CREDIT_USD * 100), locale);
  const share = new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { style: 'percent', maximumFractionDigits: 1 }).format(credits / PLAN.credits);
  return (
    <section className="pricing-estimator card">
      <div>
        <h2>{e.title}</h2>
        <p>{e.body}</p>
      </div>
      <div>
        <label htmlFor={id}>
          {e.label}
          <strong>{formatNumber(answers, locale)}</strong>
        </label>
        <input id={id} type="range" min={ESTIMATOR.min} max={ESTIMATOR.max} step={ESTIMATOR.step} value={answers} onChange={(event) => setAnswers(Number(event.target.value))} />
        <p aria-live="polite">
          <strong className="mono">{formatNumber(credits, locale)}</strong> credits <span>{fill(e.approx, { usd })}</span>
        </p>
        <small className="estimator-share">{fill(e.share, { percent: share })}</small>
      </div>
    </section>
  );
}
