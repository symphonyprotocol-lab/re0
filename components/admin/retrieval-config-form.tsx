'use client';

import { useActionState, useState } from 'react';

import { Bounded, FIELD, Field, range } from '@/components/admin/form-fields';
import { RETRIEVAL_SETTING_GROUPS } from '@/components/admin/retrieval-config-groups';
import { submitOn } from '@/components/admin/platform-asset-shared';
import { ConsoleButton } from '@/components/admin/ui';
import type { RetrievalConfigActionResult } from '@/app/admin/(console)/retrieval/actions';
import { fill } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/client';
import {
  DEFAULT_RETRIEVAL_SETTINGS,
  RETRIEVAL_SETTING_BOUNDS,
  type RetrievalSettingKey,
  type RetrievalSettings,
} from '@/lib/domain/retrieval-config';

/**
 * Retrieval's tunables, one form.
 *
 * Every save mints an immutable row (manage-retrieval-config.ts) that is in
 * force on the next request. The inputs are uncontrolled and seeded from the
 * configuration in force, so a save with no edits re-mints it faithfully; the
 * "defaults" chip re-seeds them from the domain's defaults instead -- `key`
 * on the form is what makes the browser replace the inputs rather than keep
 * the values it was ignoring.
 */
export function RetrievalConfigForm({
  current,
  action,
}: {
  current: RetrievalSettings;
  action: (
    previous: RetrievalConfigActionResult | null,
    form: FormData,
  ) => Promise<RetrievalConfigActionResult>;
}) {
  const { t } = useI18n();
  const p = t.admin.retrieval;
  const [state, formAction, pending] = useActionState(action, null);
  const [seed, setSeed] = useState<'current' | 'defaults'>('current');
  const values = seed === 'current' ? current : DEFAULT_RETRIEVAL_SETTINGS;

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
        {RETRIEVAL_SETTING_GROUPS.map((group) => (
          <fieldset
            key={group.id}
            className="flex flex-col gap-3 rounded-[9px] border-2 border-line px-3 py-2.5"
          >
            <legend className="px-1 text-[11px] font-semibold tracking-[-0.023em] text-steel">
              {p.groups[group.id]}
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              {group.keys.map((key) => (
                <Field
                  key={key}
                  label={p.fields[key].label}
                  hint={`${p.fields[key].hint} · ${range(RETRIEVAL_SETTING_BOUNDS[key])}`}
                >
                  <Bounded name={key} value={values[key]} range={RETRIEVAL_SETTING_BOUNDS[key]} />
                </Field>
              ))}
            </div>
          </fieldset>
        ))}

        <Field label={p.reason}>
          <input name="reason" className={FIELD} required />
        </Field>
        {state && !state.ok ? (
          <p className="text-[12px] tracking-[-0.023em] text-danger">{describeError(state, p)}</p>
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

type Copy = ReturnType<typeof useI18n>['t']['admin']['retrieval'];

function describeError(state: RetrievalConfigActionResult, p: Copy): string {
  if (state.error === 'out_of_range' && state.field) {
    const bounds = RETRIEVAL_SETTING_BOUNDS[state.field];
    return fill(p.errors.out_of_range, {
      field: p.fields[state.field].label,
      min: bounds.min.toLocaleString('en-US'),
      max: bounds.max.toLocaleString('en-US'),
    });
  }
  if (state.error === 'inconsistent' && state.field) {
    const byField: Partial<Record<RetrievalSettingKey, string>> = p.errors.inconsistent;
    return byField[state.field] ?? p.errors.unavailable;
  }
  return p.errors[state.error === 'reason_required' ? 'reason_required' : 'unavailable'];
}
