'use client';

import { QUERY_BASE_FEE } from '@/lib/constants';
import { VISITOR_ASK_PER_DAY, VISITOR_ASK_PER_VISITOR } from '@/lib/domain/visitor-ask';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Field } from '@/components/rees/ree-fields';

/** The settings form's copy of the visitor-ask settings: numbers as typed (NaN while a field is not a number; `perDay` null when empty). */
export interface VisitorAskForm {
  enabled: boolean;
  perVisitor: number;
  perDay: number | null;
}

/**
 * 分享页免登录提问 in a Ree's settings (lib/domain/visitor-ask.ts): the
 * switch, questions per visitor a day, and the optional daily total, with
 * what that total can cost a day and today's count.
 */
export function VisitorAskFields({ value, onChange, today }: { value: VisitorAskForm; onChange: (next: VisitorAskForm) => void; today: number }) {
  const { t, locale } = useI18n();
  const v = t.reeSetup.visitorAsks;
  const n = (number: number) => formatNumber(number, locale);
  const fee = n(QUERY_BASE_FEE);
  const number = (raw: string) => (raw.trim() === '' ? Number.NaN : Number(raw));
  return (
    <>
      <div className="field">
        <label htmlFor="edit-visitor-asks" className="flex items-start gap-2">
          <input id="edit-visitor-asks" name="visitorAsks" type="checkbox" className="mt-1 accent-blue" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} />
          <span>{v.enable}</span>
        </label>
        <small>{fill(v.hint, { fee })}</small>
      </div>
      {value.enabled && (
        <>
          <Field id="edit-visitor-asks-per-visitor" label={v.perVisitor} hint={v.perVisitorHint}>
            <input
              id="edit-visitor-asks-per-visitor"
              name="visitorAsksPerVisitor"
              type="number"
              inputMode="numeric"
              min={VISITOR_ASK_PER_VISITOR.min}
              max={VISITOR_ASK_PER_VISITOR.max}
              step={1}
              required
              value={Number.isFinite(value.perVisitor) ? value.perVisitor : ''}
              onChange={(event) => onChange({ ...value, perVisitor: number(event.target.value) })}
            />
          </Field>
          <Field id="edit-visitor-asks-per-day" label={v.perDay} hint={fill(v.perDayHint, { fee })}>
            <input
              id="edit-visitor-asks-per-day"
              name="visitorAsksPerDay"
              type="number"
              inputMode="numeric"
              min={VISITOR_ASK_PER_DAY.min}
              max={VISITOR_ASK_PER_DAY.max}
              step={1}
              value={value.perDay !== null && Number.isFinite(value.perDay) ? value.perDay : ''}
              onChange={(event) => onChange({ ...value, perDay: event.target.value.trim() === '' ? null : number(event.target.value) })}
            />
          </Field>
          <p className="form-hint">
            {[fill(v.today, { n: n(today) }), value.perDay !== null && Number.isFinite(value.perDay) ? fill(v.cost, { n: n(value.perDay * QUERY_BASE_FEE) }) : null].filter(Boolean).join(' · ')}
          </p>
        </>
      )}
    </>
  );
}
