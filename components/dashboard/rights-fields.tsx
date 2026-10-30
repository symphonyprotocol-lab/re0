'use client';

import { RIGHTS_GENERATIONS, RIGHTS_LICENSES, RIGHTS_NOTE_MAX_LENGTH, RIGHTS_ORIGINS, type RightsGeneration, type RightsLicense, type RightsOrigin } from '@/lib/domain/rights';
import { useI18n } from '@/lib/i18n/client';

/**
 * The three answers of the rights declaration (lib/domain/rights.ts) and
 * the owner's note, as one block the wizard, the metadata form and the
 * materials panel share. Controlled: the parent keeps the answers, since
 * the wizard posts them from hidden fields on another step, and the forms
 * post them under the same names (`postRights`).
 */

export interface RightsAnswer {
  origin: RightsOrigin | '';
  license: RightsLicense | '';
  generation: RightsGeneration | '';
  note: string;
}

export const EMPTY_RIGHTS: RightsAnswer = { origin: '', license: '', generation: '', note: '' };

export function rightsComplete(answer: RightsAnswer): boolean {
  return answer.origin !== '' && answer.license !== '' && answer.generation !== '';
}

/** The field names every form posts the declaration under. */
export const RIGHTS_FIELDS = {
  origin: 'rightsOrigin',
  license: 'rightsLicense',
  generation: 'rightsGeneration',
  note: 'rightsNote',
} as const;

/** The hidden inputs that carry the answers in a form whose visible fields are elsewhere. */
export function RightsHiddenFields({ value }: { value: RightsAnswer }) {
  return (
    <>
      <input type="hidden" name={RIGHTS_FIELDS.origin} value={value.origin} />
      <input type="hidden" name={RIGHTS_FIELDS.license} value={value.license} />
      <input type="hidden" name={RIGHTS_FIELDS.generation} value={value.generation} />
      <input type="hidden" name={RIGHTS_FIELDS.note} value={value.note} />
    </>
  );
}

export function RightsFields({
  value,
  onChange,
  compact = false,
}: {
  value: RightsAnswer;
  onChange: (next: RightsAnswer) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const r = t.dashboard.assets.rights;
  const groups: { key: 'origin' | 'license' | 'generation'; options: readonly string[]; labels: Record<string, string> }[] = [
    { key: 'origin', options: RIGHTS_ORIGINS, labels: r.origins },
    { key: 'license', options: RIGHTS_LICENSES, labels: r.licenses },
    { key: 'generation', options: RIGHTS_GENERATIONS, labels: r.generations },
  ];
  return (
    <div className={`flex flex-col ${compact ? 'gap-3' : 'gap-4'}`}>
      {groups.map((group) => (
        <fieldset key={group.key} className="flex flex-col gap-1.5">
          <legend className="text-[11px] font-medium text-steel">{r.labels[group.key]}</legend>
          <div className="flex flex-wrap gap-2">
            {group.options.map((option) => {
              const selected = value[group.key] === option;
              return (
                <label
                  key={option}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
                    selected ? 'border-brand bg-brandsoft text-ink' : 'border-line bg-card text-steel hover:bg-subtle'
                  }`}
                >
                  <input
                    type="radio"
                    name={`rights-${group.key}`}
                    value={option}
                    checked={selected}
                    onChange={() => onChange({ ...value, [group.key]: option })}
                    className="accent-brand"
                  />
                  {group.labels[option]}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      {value.generation === 'generated' ? (
        <p role="alert" className="rounded-md border border-rose/30 bg-rose/5 px-3 py-2 text-[11.5px] leading-[1.5] text-rose">
          {r.generatedBlocked}
        </p>
      ) : null}
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium text-steel">{r.noteLabel}</span>
        <textarea
          value={value.note}
          onChange={(event) => onChange({ ...value, note: event.target.value })}
          maxLength={RIGHTS_NOTE_MAX_LENGTH}
          rows={2}
          placeholder={r.notePlaceholder}
          className="rounded-md border border-line bg-card px-3 py-2 text-[12px] text-ink"
        />
      </label>
      <p className="text-[10.5px] leading-[1.5] text-muted">{r.responsibility}</p>
    </div>
  );
}
