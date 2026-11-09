'use client';

import { useState, type ReactNode } from 'react';
import { QUERY_FEE, REE_CATEGORIES, REE_COLORS, REE_LIMITS, type ReeCategory, type ReeColor } from '@/lib/constants';
import { CATEGORY_TAGS, charLength, normalizedTag } from '@/lib/domain/ree';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { DotAvatar, PIcon } from '@/components/rees/proto-icon';
import { ReeAvatarEditor } from '@/components/rees/ree-avatar-editor';

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

/** A labelled field with its hint (prototype dot-setup.js `field`). */
export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** Avatar, name, introduction and the default colour (prototype dot-setup.js `identity`). */
export function IdentityFields({ value, onChange, onCropping, media }: {
  value: ReeFormState;
  onChange: Change;
  onCropping?: (open: boolean) => void;
  media?: ReactNode;
}) {
  const { t } = useI18n();
  const f = t.reeSetup.fields;
  const details = (
    <>
      <Field id="edit-name" label={f.name}>
        <input
          id="edit-name"
          name="name"
          required
          maxLength={REE_LIMITS.name}
          value={value.name}
          placeholder={f.namePlaceholder}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </Field>
      <Field id="edit-description" label={f.description}>
        <textarea
          id="edit-description"
          name="description"
          rows={3}
          maxLength={REE_LIMITS.description}
          value={value.description}
          placeholder={f.descriptionPlaceholder}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </Field>
    </>
  );
  if (media) {
    return (
      <div className="ree-identity-layout">
        {media}
        <div className="ree-identity-details">{details}</div>
      </div>
    );
  }
  return (
    <>
      <ReeAvatarEditor value={value.avatarBlob} color={value.color} onChange={(avatarBlob) => onChange({ avatarBlob })} onCropping={onCropping} />
      {details}
      <ReeAvatarColors value={value.color} onChange={onChange} />
    </>
  );
}

export function ReeAvatarColors({ value, onChange, compact = false }: {
  value: ReeColor;
  onChange: Change;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const label = t.reeSetup.fields.color;
  return (
    <>
      {!compact && <span className="field-label">{label}</span>}
      <div className={`color-options ${compact ? 'ree-identity-palette' : 'mt16'}`} role="group" aria-label={label}>
        {REE_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`color-option ${value === color ? 'active' : ''}`}
            aria-label={t.common.colors[color]}
            aria-pressed={value === color}
            title={compact ? t.common.colors[color] : undefined}
            onClick={() => onChange({ color })}
          >
            <DotAvatar avatar={null} color={color} />
          </button>
        ))}
      </div>
    </>
  );
}

/** Primary category and up to three tags (prototype dot-classification.js `editor`). */
function ClassificationEditor({ category, tags, onChange }: { category: ReeCategory | ''; tags: string[]; onChange: Change }) {
  const { t, locale } = useI18n();
  const f = t.reeSetup.fields;
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  /* The prototype explains an empty list of suggestions only once the category or the search changed. */
  const [touched, setTouched] = useState(false);
  const full = tags.length >= REE_LIMITS.tags;
  const add = (raw: string) => {
    const tag = normalizedTag(raw);
    if (!tag) return;
    if (charLength(tag) > REE_LIMITS.tag) return setError(f.tagTooLong);
    if (tags.some((existing) => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) return setError(f.tagDuplicate);
    if (full) return setError(f.tagFull);
    setError('');
    setInput('');
    onChange({ tags: [...tags, tag] });
  };
  const query = normalizedTag(input).toLocaleLowerCase();
  const pool = query ? REE_CATEGORIES.flatMap((id) => CATEGORY_TAGS[id][locale]) : category ? CATEGORY_TAGS[category][locale] : [];
  const suggestions = pool
    .filter((tag) => (!query || tag.toLocaleLowerCase().includes(query)) && !tags.some((existing) => existing.toLocaleLowerCase() === tag.toLocaleLowerCase()))
    .slice(0, 8);
  return (
    <section className="dot-classification-editor">
      <Field id="dot-category" label={f.category} hint={f.categoryHint}>
        <select
          id="dot-category"
          name="category"
          required
          value={category}
          onChange={(event) => {
            setError('');
            setTouched(true);
            onChange({ category: event.target.value as ReeCategory });
          }}
        >
          <option value="" disabled>
            {f.categoryPlaceholder}
          </option>
          {REE_CATEGORIES.map((id) => (
            <option key={id} value={id}>
              {t.common.categories[id]}
            </option>
          ))}
        </select>
      </Field>
      <div className="between classification-label">
        <span className="field-label">{f.tags}</span>
        <span className="classification-count">
          {tags.length} / {REE_LIMITS.tags}
        </span>
      </div>
      <div className="classification-selected">
        {tags.map((tag) => (
          <span key={tag} className="classification-chip">
            <span>{tag}</span>
            <button
              type="button"
              aria-label={fill(f.tagRemove, { tag })}
              onClick={() => {
                setError('');
                onChange({ tags: tags.filter((existing) => existing !== tag) });
              }}
            >
              <PIcon name="close" />
            </button>
          </span>
        ))}
      </div>
      <div className="classification-search">
        <PIcon name="search" />
        <input
          type="search"
          aria-label={f.tagSearch}
          placeholder={f.tagInput}
          maxLength={100}
          value={input}
          onChange={(event) => {
            setTouched(true);
            setInput(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              add(input);
            }
          }}
        />
        <button type="button" className="btn secondary sm" disabled={!query || full} onClick={() => add(input)}>
          {f.tagAdd}
        </button>
      </div>
      <div className="classification-suggestions">
        {suggestions.length > 0
          ? suggestions.map((tag) => (
              <button key={tag} type="button" className="classification-suggestion" disabled={full} onClick={() => add(tag)}>
                <PIcon name="plus" />
                {tag}
              </button>
            ))
          : touched && <span className="classification-hint">{query ? f.tagNoMatch : f.tagNoCategory}</span>}
      </div>
      <small className="classification-hint">{f.tagsHint}</small>
      <p className="classification-error" role="alert" hidden={!error}>
        {error}
      </p>
    </section>
  );
}

/** Classification, answer style and sample questions (prototype dot-setup.js `personality`). */
export function PersonalityFields({ value, onChange, children }: { value: ReeFormState; onChange: Change; children?: ReactNode }) {
  const { t } = useI18n();
  const f = t.reeSetup.fields;
  return (
    <>
      <ClassificationEditor category={value.category} tags={value.tags} onChange={onChange} />
      <Field id="edit-prompt" label={f.prompt} hint={f.promptHint}>
        <textarea
          id="edit-prompt"
          name="prompt"
          rows={5}
          maxLength={REE_LIMITS.systemPrompt}
          value={value.systemPrompt}
          placeholder={f.promptPlaceholder}
          onChange={(event) => onChange({ systemPrompt: event.target.value })}
        />
      </Field>
      <Field id="edit-samples" label={f.samples} hint={f.samplesHint}>
        <textarea
          id="edit-samples"
          name="samples"
          rows={4}
          value={value.sampleQuestions}
          placeholder={f.samplesPlaceholder}
          onChange={(event) => onChange({ sampleQuestions: event.target.value })}
        />
      </Field>
      {children}
    </>
  );
}

/** Visibility and the query fee; a taken-down Ree cannot be made public by its owner (prototype dot-setup.js `publishing`). */
export function PublishingFields({ value, onChange, moderated = false }: { value: ReeFormState; onChange: Change; moderated?: boolean }) {
  const { t } = useI18n();
  const f = t.reeSetup.fields;
  return (
    <>
      <div className="setup-visibility">
        {([false, true] as const).map((isPublic) => (
          <label key={String(isPublic)}>
            <input
              type="radio"
              name="visibility"
              value={isPublic ? 'public' : 'private'}
              checked={value.isPublic === isPublic}
              disabled={moderated && isPublic}
              onChange={() => onChange({ isPublic })}
            />
            <span>
              <PIcon name={isPublic ? 'globe' : 'lock'} />
              <strong>{isPublic ? f.public : f.private}</strong>
              <small>{isPublic ? f.publicHint : f.privateHint}</small>
            </span>
          </label>
        ))}
      </div>
      {moderated && <p className="form-hint">{t.reeSetup.settings.moderatedHint}</p>}
      <Field id="edit-fee" label={f.fee} hint={f.feeHint}>
        <input
          id="edit-fee"
          name="fee"
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
