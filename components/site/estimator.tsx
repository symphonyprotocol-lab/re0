'use client';

import { useId, useState } from 'react';
import { CREDIT_USD, ESTIMATOR, PLAN, QUERY_BASE_FEE } from '@/lib/constants';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';

/** The pricing page's slider (prototype `#question-range`): answers on your own Ree, in credits and dollars. */
export function Estimator() {
  const { t, locale } = useI18n();
  const e = t.site.pricing.estimator;
  const id = useId();
  const [answers, setAnswers] = useState<number>(ESTIMATOR.default);
  const credits = answers * QUERY_BASE_FEE;
  const usd = new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(credits * CREDIT_USD);
  const share = new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { style: 'percent', maximumFractionDigits: 1 }).format(credits / PLAN.credits);
  return (
    <section className="card grid gap-6 p-6 md:grid-cols-2 md:p-8">
      <div>
        <h2 className="text-[20px] font-bold">{e.title}</h2>
        <p className="mt-2 text-[13px] text-muted">{e.body}</p>
      </div>
      <div>
        <label htmlFor={id} className="flex items-center justify-between text-[13px] font-semibold">
          {e.label}
          <strong className="font-mono text-[15px] text-blue">{formatNumber(answers, locale)}</strong>
        </label>
        <input
          id={id}
          type="range"
          min={ESTIMATOR.min}
          max={ESTIMATOR.max}
          step={ESTIMATOR.step}
          value={answers}
          onChange={(event) => setAnswers(Number(event.target.value))}
          className="mt-3 w-full accent-blue"
        />
        <p className="mt-3 flex flex-wrap items-baseline gap-x-2" aria-live="polite">
          <strong className="font-mono text-[26px]">{formatNumber(credits, locale)}</strong>
          <span className="text-[12px] text-muted">credits</span>
          <span className="text-[13px] text-muted">{fill(e.approx, { usd })}</span>
        </p>
        <p className="text-[12px] text-muted">{fill(e.share, { percent: share })}</p>
      </div>
    </section>
  );
}
