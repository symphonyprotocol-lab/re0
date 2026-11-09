/**
 * The five verification checks with "值 / 目标" and what is still missing
 * (prototype role-pages.js `checks()`), shared by the role tab and the
 * console's user and review pages. Server-safe; the wording is `t.roles`.
 */
import type { Messages } from '@/i18n';
import type { Locale } from '@/i18n/locale';
import { fill, formatNumber } from '@/i18n/format';
import { verificationChecks, type RoleMetrics } from '@/lib/domain/roles';
import { Icon } from '@/components/ui/icons';

export function RequirementChecks({ t, locale, metrics, className = '' }: { t: Messages; locale: Locale; metrics: RoleMetrics; className?: string }) {
  const q = t.roles.requirements;
  const n = (value: number) => formatNumber(value, locale);
  return (
    <ul className={`divide-y divide-line ${className}`}>
      {verificationChecks(metrics).map((check) => {
        const value =
          check.key === 'helpfulRate'
            ? check.value === null
              ? q.noFeedback
              : fill(q.rate, { rate: Math.round(check.value * 1000) / 10, count: n(metrics.feedbackCount) })
            : fill(q.value, { value: n(check.value ?? 0), target: n(check.target) });
        const missing = check.passed ? q.met : check.missing === null ? q.needFeedback : fill(q.missing[check.key], { n: n(check.missing) });
        return (
          <li key={check.key} className="flex items-center gap-3 py-3.5">
            <span
              className={`inline-flex size-7 flex-none items-center justify-center rounded-lg ${check.passed ? 'bg-[#eaf7f2] text-green' : 'bg-[#f4f5fa] text-[#a1aec5]'}`}
              aria-label={check.passed ? q.metLabel : q.pendingLabel}
              role="img"
            >
              <Icon name={check.passed ? 'check' : 'clock'} className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <strong className="block text-[13px] font-semibold">{q.items[check.key]}</strong>
              <span className="mt-0.5 block font-mono text-[11px] text-muted">{value}</span>
            </div>
            <small className={`max-w-[45%] flex-none text-right text-[11px] ${check.passed ? 'text-green' : 'text-orange'}`}>{missing}</small>
          </li>
        );
      })}
    </ul>
  );
}
