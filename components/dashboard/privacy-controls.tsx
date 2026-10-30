'use client';

import { useActionState, useState } from 'react';
import { deleteRecordsAction, setRetentionAction, type PrivacyResult } from '@/app/dashboard/privacy/actions';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

const SECONDARY =
  'h-9 rounded-md border border-line px-3.5 text-[12px] text-ink transition-colors hover:bg-subtle disabled:opacity-50';

/** One-click deletion, asked twice: there is no undo (agent-first-proposal.md 10). */
export function DeleteRecordsButton({ what }: { what: 'conversations' | 'tasks' }) {
  const { t } = useI18n();
  const p = t.dashboard.privacyData;
  const [armed, setArmed] = useState(false);
  const [result, remove, removing] = useActionState<PrivacyResult | null, FormData>(deleteRecordsAction, null);
  const label = what === 'conversations' ? p.deleteConversations : p.deleteTasks;
  return (
    <div className="flex flex-col gap-1">
      {armed && !result?.ok ? (
        <form action={remove}>
          <input type="hidden" name="what" value={what} />
          <button type="submit" disabled={removing} className={`${SECONDARY} border-warn text-warn`}>
            {p.deleteConfirm}
          </button>
        </form>
      ) : (
        <button type="button" onClick={() => setArmed(true)} className={`${SECONDARY} text-warn`}>
          {label}
        </button>
      )}
      {result?.ok ? <p className="text-[11.5px] text-brandink">{fill(p.deleted, { n: String(result.count ?? 0) })}</p> : null}
      {result?.error ? (
        <p role="alert" className="text-[11.5px] text-warn">
          {p.errors[result.error]}
        </p>
      ) : null}
    </div>
  );
}

export function RetentionForm({ current, choices }: { current: number | null; choices: readonly number[] }) {
  const { t } = useI18n();
  const p = t.dashboard.privacyData;
  const [result, save, saving] = useActionState<PrivacyResult | null, FormData>(setRetentionAction, null);
  return (
    <form action={save} className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          name="days"
          defaultValue={current === null ? 'keep' : String(current)}
          aria-label={p.retentionTitle}
          className="h-9 rounded-md border border-line bg-card px-3 text-[12.5px] text-ink sm:w-56"
        >
          <option value="keep">{p.retentionKeep}</option>
          {choices.map((days) => (
            <option key={days} value={String(days)}>
              {fill(p.retentionDays, { n: String(days) })}
            </option>
          ))}
        </select>
        <button type="submit" disabled={saving} className={SECONDARY}>
          {p.retentionSave}
        </button>
      </div>
      {result?.ok ? <p className="text-[11.5px] text-brandink">{p.retentionSaved}</p> : null}
      {result?.error ? (
        <p role="alert" className="text-[11.5px] text-warn">
          {p.errors[result.error]}
        </p>
      ) : null}
    </form>
  );
}
