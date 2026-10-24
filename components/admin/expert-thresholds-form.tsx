'use client';

import { useActionState, useState } from 'react';
import { Bounded, FIELD, Field, range } from '@/components/admin/form-fields';
import { submitOn } from '@/components/admin/platform-library-shared';
import { ConsoleButton } from '@/components/admin/ui';
import type { ExpertThresholdsActionResult } from '@/app/admin/(console)/expert-libraries/actions';
import {
  DEFAULT_EXPERT_THRESHOLDS,
  EXPERT_THRESHOLD_BOUNDS,
  EXPERT_THRESHOLD_KEYS,
  type ExpertThresholds,
} from '@/lib/domain/expert-thresholds';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * The expert gate's thresholds, one form (review-visibility-proposal.md
 * 5.3). Like retrieval's tunables: every save mints an immutable row that
 * is in force for the next application, the inputs are seeded from the
 * thresholds in force, and the defaults chip re-seeds them from the domain.
 */
export function ExpertThresholdsForm({
  current,
  action,
}: {
  current: ExpertThresholds;
  action: (previous: ExpertThresholdsActionResult | null, form: FormData) => Promise<ExpertThresholdsActionResult>;
}) {
  const { t } = useI18n();
  const p = t.admin.expertThresholds;
  const [state, formAction, pending] = useActionState(action, null);
  const [seed, setSeed] = useState<'current' | 'defaults'>('current');
  const values = seed === 'current' ? current : DEFAULT_EXPERT_THRESHOLDS;

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap gap-2 px-[19px] pt-4">
        {(['current', 'defaults'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            onClick={() => setSeed(choice)}
            aria-current={seed === choice ? 'true' : undefined}
            className={`rounded-[9px] border-2 px-3 py-2 text-[12px] font-semibold tracking-[-0.023em] transition-colors ${
              seed === choice ? 'border-brand bg-brandsoft text-ink' : 'border-line bg-card text-muted hover:text-ink'
            }`}
          >
            {choice === 'current' ? p.seedCurrent : p.seedDefaults}
          </button>
        ))}
      </div>

      <form key={seed} onSubmit={submitOn(formAction)} className="flex flex-col gap-4 px-[19px] py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {EXPERT_THRESHOLD_KEYS.map((key) => (
            <Field key={key} label={p.fields[key].label} hint={`${p.fields[key].hint} · ${range(EXPERT_THRESHOLD_BOUNDS[key])}`}>
              <Bounded name={key} value={values[key]} range={EXPERT_THRESHOLD_BOUNDS[key]} />
            </Field>
          ))}
        </div>
        <Field label={p.reason}>
          <input name="reason" className={FIELD} required />
        </Field>
        {state && !state.ok ? (
          <p className="text-[12px] tracking-[-0.023em] text-danger">
            {state.error === 'out_of_range' && state.field
              ? fill(p.errors.out_of_range, {
                  field: p.fields[state.field].label,
                  min: String(EXPERT_THRESHOLD_BOUNDS[state.field].min),
                  max: String(EXPERT_THRESHOLD_BOUNDS[state.field].max),
                })
              : p.errors[state.error === 'reason_required' ? 'reason_required' : 'unavailable']}
          </p>
        ) : null}
        {state?.ok ? <p className="text-[12px] tracking-[-0.023em] text-steel">{p.saved}</p> : null}
        <div>
          <ConsoleButton type="submit" variant="primary" disabled={pending}>
            {p.save}
          </ConsoleButton>
        </div>
      </form>
    </div>
  );
}
