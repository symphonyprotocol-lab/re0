'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useState } from 'react';
import { validateReeFields, type ReeFieldError } from '@/lib/domain/ree';
import type { ReeCategory, ReeColor } from '@/lib/constants';
import type { Ree } from '@/lib/services/rees';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { ConfirmModal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { IdentityFields, PersonalityFields, PublishingFields, type ReeFormState } from '@/components/rees/ree-fields';
import { DotAvatar, PIcon } from '@/components/rees/proto-icon';
import './ree-pages.css';
import './ree-settings.css';

function formOf(ree: Ree): ReeFormState {
  return {
    name: ree.name,
    description: ree.description,
    avatarBlob: ree.avatarBlob,
    color: ree.color as ReeColor,
    category: ree.category as ReeCategory,
    tags: ree.tags,
    systemPrompt: ree.systemPrompt,
    sampleQuestions: ree.sampleQuestions.join('\n'),
    isPublic: ree.isPublic && !ree.moderatedAt,
    queryFee: ree.queryFee,
  };
}

/**
 * `/rees/[id]/settings`: identity, knowledge & personality, publishing &
 * pricing as three sections of one form; the summary on the right shows what
 * is saved, not what is being typed -- `sources` counts every live source,
 * whatever its status, as the prototype's summary does. Deletion is soft.
 */
export function ReeSettings({ ree, sources }: { ree: Ree; sources: number }) {
  const { t } = useI18n();
  const s = t.reeSetup.settings;
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState<ReeFormState>(() => formOf(ree));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cropping, setCropping] = useState(false);
  const moderated = Boolean(ree.moderatedAt);

  const save = async () => {
    /* An open avatar crop is applied or cancelled first (prototype dot-avatar.js `beforeSubmit`). */
    if (cropping) {
      setError(t.reeSetup.messages.crop);
      return;
    }
    const invalid = validateReeFields(form, 4);
    if (invalid) {
      setError(t.reeSetup.messages[invalid.error]);
      return;
    }
    setSaving(true);
    setError('');
    const result = await api<{ ree?: Ree; error?: ReeFieldError }>(`/api/rees/${ree.id}`, {
      method: 'PATCH',
      json: { ...form, sampleQuestions: form.sampleQuestions },
    });
    setSaving(false);
    if (!result.ok) {
      const code = result.data.error;
      setError(code && code in t.reeSetup.messages ? t.reeSetup.messages[code] : t.common.errors.generic);
      return;
    }
    toast(s.saved);
    router.refresh();
  };

  const update = (patch: Partial<ReeFormState>) => setForm((current) => ({ ...current, ...patch }));

  return (
    <main className="page dot-settings-page">
      <form
        id="dot-settings-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="setup-page-heading">
          <div>
            <h1>{s.title}</h1>
            <p>{s.lede}</p>
          </div>
          <button type="submit" className="btn" disabled={saving}>
            {saving ? s.saving : s.save}
            <PIcon name="check" />
          </button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dot-settings-grid">
          <div>
            <section className="card setup-section">
              <h2>{s.identity}</h2>
              <IdentityFields value={form} onChange={update} onCropping={setCropping} />
            </section>
            <section className="card setup-section">
              <h2>{s.personality}</h2>
              <PersonalityFields value={form} onChange={update}>
                {/* Step 4: the system's three suggestions, shown publicly only once adopted here and saved (8.2, "示例问题"). */}
                {!form.sampleQuestions.trim() && ree.suggestedQuestions.length > 0 && (
                  <div className="info-strip setup-suggested">
                    <PIcon name="sparkle" />
                    <span>
                      <strong>{t.discover.settings.suggestedTitle}</strong>
                      <br />
                      {t.discover.settings.suggestedBody}
                      <ol>
                        {ree.suggestedQuestions.map((question) => (
                          <li key={question}>{question}</li>
                        ))}
                      </ol>
                      <button
                        type="button"
                        className="btn secondary sm"
                        onClick={() => {
                          update({ sampleQuestions: ree.suggestedQuestions.join('\n') });
                          toast(t.discover.settings.adopted);
                        }}
                      >
                        <PIcon name="check" />
                        {t.discover.settings.adopt}
                      </button>
                    </span>
                  </div>
                )}
              </PersonalityFields>
            </section>
            <section className="card setup-section">
              <h2>{s.publishing}</h2>
              <PublishingFields value={form} onChange={update} moderated={moderated} />
            </section>
            <div className="setup-settings-actions">
              <button type="button" className="btn secondary" onClick={() => setForm(formOf(ree))}>
                {s.discard}
              </button>
              <button type="submit" className="btn" disabled={saving}>
                {saving ? s.saving : s.save}
              </button>
            </div>
          </div>
          <aside>
            <section className="card setup-summary">
              <DotAvatar avatar={ree.avatarBlob} color={ree.color} />
              <h2>{ree.name}</h2>
              <span className="tag blue">{t.common.categories[ree.category as ReeCategory]}</span>
              <p>{ree.description}</p>
              <Link href={`/rees/${ree.id}/knowledge`}>
                <PIcon name="file" />
                {fill(s.sources, { count: sources })}
                <PIcon name="arrow" />
              </Link>
              <Link href={`/rees/${ree.id}/chat`}>
                <PIcon name="chat" />
                {s.test}
                <PIcon name="arrow" />
              </Link>
              {ree.isPublic && !moderated && (
                <Link href={`/r/${ree.slug}`}>
                  <PIcon name="external" />
                  {s.viewPublic}
                  <PIcon name="arrow" />
                </Link>
              )}
              <small>{s.summaryNote}</small>
            </section>
            <section className="card setup-danger">
              <h3>{s.dangerTitle}</h3>
              <p>{s.dangerBody}</p>
              <button type="button" className="text-link" onClick={() => setConfirmDelete(true)}>
                <PIcon name="trash" />
                {s.delete}
              </button>
            </section>
          </aside>
        </div>
      </form>
      <ConfirmModal
        open={confirmDelete}
        danger
        busy={deleting}
        title={fill(s.deleteTitle, { name: ree.name })}
        body={s.deleteBody}
        confirmLabel={s.delete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setDeleting(true);
          const result = await api(`/api/rees/${ree.id}`, { method: 'DELETE' });
          setDeleting(false);
          if (!result.ok) return setError(t.common.errors.generic);
          toast(s.deleted);
          router.push('/rees');
          router.refresh();
        }}
      />
    </main>
  );
}
