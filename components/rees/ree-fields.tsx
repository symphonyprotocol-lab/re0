'use client';

import { useState, type ReactNode } from 'react';
import { QUERY_FEE, REE_CATEGORIES, REE_COLORS, REE_LIMITS, type ReeCategory, type ReeColor } from '@/lib/constants';
import { CATEGORY_TAGS, charLength, normalizedTag } from '@/lib/domain/ree';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { AvatarEditor } from '@/components/rees/avatar-editor';

/** What the wizard and the settings page edit. */
export interface ReeFormState {
  name: string;
  description: string;
  avatarBlob: string | null;
  color: ReeColor;
  category: ReeCategory | '';
  tags: string[];
  systemPrompt: string;
  sampleQuestions: string;
  isPublic: boolean;
  queryFee: number;
}

type Change = (patch: Partial<ReeFormState>) => void;

export function Field({ id, label, hint, counter, children }: { id: string; label: string; hint?: string; counter?: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        {counter && <span className="font-mono text-[10px] text-muted">{counter}</span>}
      </div>
      {children}
      {hint && <small className="hint">{hint}</small>}
    </div>
  );
}

export function IdentityFields({ value, onChange, onCropping }: { value: ReeFormState; onChange: Change; onCropping?: (open: boolean) => void }) {
  const { t } = useI18n();
  const f = t.reeSetup.fields;
  return (
    <>
      <AvatarEditor
        value={value.avatarBlob}
        color={value.color}
        onChange={(avatarBlob) => onChange({ avatarBlob })}
        labels={{ title: f.avatar, upload: f.avatarUpload, change: f.avatarChange, reset: f.avatarDefault, hint: f.avatarHint, note: f.avatarNote }}
        onCropping={onCropping}
      />
      <Field id="ree-name" label={f.name} counter={fill(f.counter, { count: charLength(value.name), max: REE_LIMITS.name })}>
        <input
          id="ree-name"
          className="input"
          required
          maxLength={REE_LIMITS.name}
          value={value.name}
          placeholder={f.namePlaceholder}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </Field>
      <Field id="ree-description" label={f.description} counter={fill(f.counter, { count: charLength(value.description), max: REE_LIMITS.description })}>
        <textarea
          id="ree-description"
          className="input min-h-[84px] resize-y"
          rows={3}
          maxLength={REE_LIMITS.description}
          value={value.description}
          placeholder={f.descriptionPlaceholder}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </Field>
      <div className="mt-5">
        <span className="field-label">{f.color}</span>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={f.color}>
          {REE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={value.color === color}
              aria-label={t.common.colors[color]}
              title={t.common.colors[color]}
              onClick={() => onChange({ color })}
              className={`rounded-2xl p-1 ring-2 transition ${value.color === color ? 'ring-blue' : 'ring-transparent hover:ring-line'}`}
            >
              <ReeAvatar color={color} />
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function TagsEditor({ category, tags, onChange }: { category: ReeCategory | ''; tags: string[]; onChange: (tags: string[]) => void }) {
  const { t, locale } = useI18n();
  const f = t.reeSetup.fields;
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const add = (raw: string) => {
    const tag = normalizedTag(raw);
    if (!tag) return;
    if (charLength(tag) > REE_LIMITS.tag) return setError(t.reeSetup.messages.length);
    if (tags.some((existing) => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) return setInput('');
    if (tags.length >= REE_LIMITS.tags) return setError(t.reeSetup.messages.limit);
    setError('');
    setInput('');
    onChange([...tags, tag]);
  };
  const query = normalizedTag(input).toLocaleLowerCase();
  const pool = query
    ? REE_CATEGORIES.flatMap((id) => CATEGORY_TAGS[id][locale])
    : category
      ? CATEGORY_TAGS[category][locale]
      : [];
  const suggestions = pool
    .filter((tag) => (!query || tag.toLocaleLowerCase().includes(query)) && !tags.some((existing) => existing.toLocaleLowerCase() === tag.toLocaleLowerCase()))
    .slice(0, 8);
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor="ree-tag-input" className="field-label">
          {f.tags}
        </label>
        <span className="font-mono text-[10px] text-muted">
          {tags.length} / {REE_LIMITS.tags}
        </span>
      </div>
      {tags.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-full border border-[#d8e6fb] bg-soft py-1 pr-1 pl-3 text-[12px] font-medium text-blue">
              {tag}
              <button
                type="button"
                className="inline-flex size-5 items-center justify-center rounded-full hover:bg-white"
                aria-label={fill(f.tagRemove, { tag })}
                onClick={() => onChange(tags.filter((existing) => existing !== tag))}
              >
                <Icon name="close" className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          id="ree-tag-input"
          className="input"
          value={input}
          aria-label={f.tagSearch}
          placeholder={f.tagInput}
          disabled={tags.length >= REE_LIMITS.tags}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              add(input);
            }
          }}
        />
        <button type="button" className="btn-secondary" onClick={() => add(input)} disabled={!input.trim() || tags.length >= REE_LIMITS.tags}>
          {f.tagAdd}
        </button>
      </div>
      {tags.length < REE_LIMITS.tags &&
        (suggestions.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.map((tag) => (
              <button key={tag} type="button" className="tag hover:border-blue hover:text-blue" onClick={() => add(tag)}>
                <Icon name="plus" className="size-3" />
                {tag}
              </button>
            ))}
          </div>
        ) : (
          /* No suggestion to show: say why (prototype dot-classification.js `suggestions`). */
          <p className="mt-2 text-[11px] text-muted">{query ? f.tagNoMatch : f.tagNoCategory}</p>
        ))}
      {error && (
        <p role="alert" className="mt-1.5 text-[11px] text-red">
          {error}
        </p>
      )}
      <small className="hint">{f.tagsHint}</small>
    </div>
  );
}

export function PersonalityFields({ value, onChange }: { value: ReeFormState; onChange: Change }) {
  const { t } = useI18n();
  const f = t.reeSetup.fields;
  return (
    <>
      <Field id="ree-category" label={f.category} hint={f.categoryHint}>
        <select
          id="ree-category"
          className="input"
          value={value.category}
          required
          onChange={(event) => onChange({ category: event.target.value as ReeCategory })}
        >
          <option value="" disabled>
            {f.categoryPlaceholder}
          </option>
          {REE_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {t.common.categories[category]}
            </option>
          ))}
        </select>
      </Field>
      <TagsEditor category={value.category} tags={value.tags} onChange={(tags) => onChange({ tags })} />
      <Field id="ree-prompt" label={f.prompt} hint={f.promptHint} counter={fill(f.counter, { count: charLength(value.systemPrompt), max: REE_LIMITS.systemPrompt })}>
        <textarea
          id="ree-prompt"
          className="input min-h-[120px] resize-y"
          rows={5}
          maxLength={REE_LIMITS.systemPrompt}
          value={value.systemPrompt}
          placeholder={f.promptPlaceholder}
          onChange={(event) => onChange({ systemPrompt: event.target.value })}
        />
      </Field>
      <Field id="ree-samples" label={f.samples} hint={f.samplesHint}>
        <textarea
          id="ree-samples"
          className="input min-h-[96px] resize-y"
          rows={4}
          value={value.sampleQuestions}
          placeholder={f.samplesPlaceholder}
          onChange={(event) => onChange({ sampleQuestions: event.target.value })}
        />
      </Field>
    </>
  );
}

/** `moderated`: a taken-down Ree cannot be made public by its owner (prototype dot-setup.js `publishing`). */
export function PublishingFields({ value, onChange, moderated = false }: { value: ReeFormState; onChange: Change; moderated?: boolean }) {
  const { t } = useI18n();
  const f = t.reeSetup.fields;
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup">
        {([false, true] as const).map((isPublic) => (
          <label
            key={String(isPublic)}
            className={`flex gap-3 rounded-xl border p-4 transition ${
              moderated && isPublic ? 'cursor-not-allowed border-line opacity-50' : value.isPublic === isPublic ? 'cursor-pointer border-blue bg-soft' : 'cursor-pointer border-line hover:border-[#c4cce0]'
            }`}
          >
            <input
              type="radio"
              name="visibility"
              className="mt-1"
              checked={value.isPublic === isPublic}
              disabled={moderated && isPublic}
              onChange={() => onChange({ isPublic })}
            />
            <span>
              <strong className="flex items-center gap-1.5 text-[13px]">
                <Icon name={isPublic ? 'globe' : 'lock'} className="size-4" />
                {isPublic ? f.public : f.private}
              </strong>
              <small className="mt-1 block text-[11px] text-muted">{isPublic ? f.publicHint : f.privateHint}</small>
            </span>
          </label>
        ))}
      </div>
      {moderated && <small className="hint">{t.reeSetup.settings.moderatedHint}</small>}
      <Field id="ree-fee" label={f.fee} hint={f.feeHint}>
        <input
          id="ree-fee"
          className="input max-w-[220px] font-mono"
          type="number"
          min={QUERY_FEE.min}
          max={QUERY_FEE.max}
          step={1}
          required
          value={Number.isFinite(value.queryFee) ? value.queryFee : ''}
          onChange={(event) => onChange({ queryFee: event.target.value === '' ? Number.NaN : Number(event.target.value) })}
        />
      </Field>
    </>
  );
}
