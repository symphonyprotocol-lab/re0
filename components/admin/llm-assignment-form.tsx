'use client';

import { useActionState } from 'react';

import { FIELD, Field } from '@/components/admin/form-fields';
import { submitOn } from '@/components/admin/platform-library-shared';
import { ConsoleButton } from '@/components/admin/ui';
import type { LlmConfigActionResult } from '@/app/admin/(console)/models/actions';
import { useI18n } from '@/lib/i18n/client';

export interface AssignableModel {
  slug: string;
  label: string;
  model: string;
  enabled: boolean;
}

/**
 * Who is answered by which model: two pickers over the registry.
 *
 * The blank option of each select is the documented null -- the newest
 * enabled entry for trial callers, the trial model for subscribers -- so an
 * installation that never assigned anything is shown exactly what it is
 * doing, and can keep doing it on purpose. Disabled entries are listed but
 * cannot be chosen: assigning a model that cannot answer is refused below.
 */
export function LlmAssignmentForm({
  models,
  trialSlug,
  subscriberSlug,
  action,
}: {
  models: AssignableModel[];
  trialSlug: string | null;
  subscriberSlug: string | null;
  action: (previous: LlmConfigActionResult | null, form: FormData) => Promise<LlmConfigActionResult>;
}) {
  const { t } = useI18n();
  const p = t.admin.llm;
  const [state, formAction, pending] = useActionState(action, null);

  const options = models.map((model) => (
    <option key={model.slug} value={model.slug} disabled={!model.enabled}>
      {model.label} · {model.model}
      {model.enabled ? '' : ` (${p.stateDisabled})`}
    </option>
  ));

  return (
    <form
      key={`${trialSlug ?? ''}|${subscriberSlug ?? ''}`}
      onSubmit={submitOn(formAction)}
      className="flex flex-col gap-4 px-[19px] py-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={p.trialModel} hint={p.trialModelHint}>
          <select name="trialSlug" defaultValue={trialSlug ?? ''} className={FIELD}>
            <option value="">{p.trialAuto}</option>
            {options}
          </select>
        </Field>
        <Field label={p.subscriberModel} hint={p.subscriberModelHint}>
          <select name="subscriberSlug" defaultValue={subscriberSlug ?? ''} className={FIELD}>
            <option value="">{p.subscriberSameAsTrial}</option>
            {options}
          </select>
        </Field>
      </div>
      <Field label={p.reason}>
        <input name="reason" className={FIELD} required />
      </Field>
      {state && !state.ok ? (
        <p className="text-[12px] tracking-[-0.023em] text-danger">
          {p.errors[state.error ?? 'unavailable']}
        </p>
      ) : null}
      {state?.ok ? (
        <p className="text-[12px] tracking-[-0.023em] text-steel">{p.assignmentSaved}</p>
      ) : null}
      <div>
        <ConsoleButton type="submit" variant="primary" disabled={pending || models.length === 0}>
          {p.assignmentSave}
        </ConsoleButton>
      </div>
    </form>
  );
}
