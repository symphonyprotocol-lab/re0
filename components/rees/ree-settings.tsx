'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useEffect, useState, type ReactNode } from 'react';
import { sampleQuestionList, validateReeFields, type ReeFieldError } from '@/lib/domain/ree';
import type { IntroProps } from '@/lib/domain/video';
import type { ReeCategory, ReeColor } from '@/lib/constants';
import type { Ree } from '@/lib/services/rees';
import { api, uploadToBlob } from '@/lib/client/upload';
import { dropSettingsDraft, keepSettingsDraft, keptSettingsDraft, reePreviewHref } from '@/lib/client/ree-preview';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { ConfirmModal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { IdentityFields, PersonalityFields, PublishingFields, ReeAvatarColors, type ReeFormState } from '@/components/rees/ree-fields';
import { ReeCoverEditor } from '@/components/rees/ree-cover-editor';
import { ReeAvatarEditor } from '@/components/rees/ree-avatar-editor';
import { ReeSettingsPreview } from '@/components/rees/ree-settings-preview-button';
import { PIcon } from '@/components/rees/proto-icon';
import './ree-pages.css';
import './ree-settings.css';

type CoverEdit = { file: File; pathname?: string } | null | undefined;
type KeptSettings = { form: ReeFormState; coverEdit: CoverEdit };

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
 * pricing as three sections of one form. The summary follows edits as
 * they're made, while `sources` counts all live sources.
 */
export function ReeSettings({ ree, sources, video, topbar }: { ree: Ree; sources: number; video: IntroProps | null; topbar: ReactNode }) {
  const { t, locale } = useI18n();
  const s = t.reeSetup.settings;
  const router = useRouter();
  const toast = useToast();
  /* Edits left unsaved for the preview come back with "Back to settings" or the browser's back. */
  const [kept] = useState(() => keptSettingsDraft<KeptSettings>(ree.id));
  const [form, setForm] = useState<ReeFormState>(() => kept?.form ?? formOf(ree));
  const [coverEdit, setCoverEdit] = useState<CoverEdit>(kept?.coverEdit);
  useEffect(() => dropSettingsDraft(ree.id), [ree.id]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cropping, setCropping] = useState(false);
  const moderated = Boolean(ree.moderatedAt);
  const cover = coverEdit === undefined ? ree.coverBlob : coverEdit?.file ?? null;
  useEffect(() => {
    const pathname = coverEdit === null ? null : coverEdit?.pathname;
    if (pathname === ree.coverBlob) setCoverEdit(undefined);
  }, [coverEdit, ree.coverBlob]);

  const preview = () => {
    keepSettingsDraft<KeptSettings>(ree.id, { form, coverEdit });
    router.push(reePreviewHref(ree, {
      name: form.name.trim(),
      description: form.description.trim(),
      avatarBlob: form.avatarBlob,
      color: form.color,
      category: form.category,
      tags: form.tags,
      sampleQuestions: sampleQuestionList(form.sampleQuestions),
      queryFee: Number.isFinite(form.queryFee) ? form.queryFee : null,
    }, cover));
  };

  const save = async () => {
    if (saving) return;
    /* An open avatar crop is applied or cancelled first (prototype dot-avatar.js `beforeSubmit`). */
    if (cropping) {
      setError(t.reeSetup.messages.crop);
      return;
    }
    const invalid = validateReeFields(form, 3);
    if (invalid) {
      setError(t.reeSetup.messages[invalid.error]);
      return;
    }
    setSaving(true);
    setError('');
    try {
      let coverBlob = coverEdit === null ? null : coverEdit?.pathname;
      if (coverEdit && !coverEdit.pathname) {
        const { file } = coverEdit;
        const upload = await uploadToBlob(file, { purpose: 'ree-cover', reeId: ree.id, contentType: file.type, size: file.size });
        if ('error' in upload) {
          setError(upload.error === 'invalid_cover' ? s.cover.invalid : s.cover.failed);
          return;
        }
        coverBlob = upload.pathname;
        setCoverEdit({ file, pathname: coverBlob });
      }
      const result = await api<{ error?: ReeFieldError | 'invalid_cover' }>(`/api/rees/${ree.id}`, {
        method: 'PATCH',
        json: { ...form, coverBlob },
      });
      if (!result.ok) {
        const code = result.data.error;
        setError(code === 'invalid_cover' ? s.cover.failed : code && code in t.reeSetup.messages ? t.reeSetup.messages[code] : t.common.errors.generic);
        return;
      }
      toast(s.saved);
      router.refresh();
    } catch {
      setError(t.common.errors.generic);
    } finally {
      setSaving(false);
    }
  };

  const update = (patch: Partial<ReeFormState>) => setForm((current) => ({ ...current, ...patch }));

  return (
    <>
      <ReeSettingsPreview.Provider value={preview}>{topbar}</ReeSettingsPreview.Provider>
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
              <section className="card setup-section ree-identity-section">
                <h2>{s.identity}</h2>
                <IdentityFields value={form} onChange={update} media={
                  <ReeCoverEditor
                    value={cover}
                    disabled={saving}
                    onChange={(file) => setCoverEdit(file ? { file } : null)}
                    avatar={form.avatarBlob}
                    color={form.color}
                    video={video}
                    palette={<ReeAvatarColors value={form.color} onChange={update} compact />}
                  >
                    <ReeAvatarEditor
                      value={form.avatarBlob}
                      color={form.color}
                      onChange={(avatarBlob) => update({ avatarBlob })}
                      onCropping={setCropping}
                      compact
                    />
                  </ReeCoverEditor>
                } />
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
                <button type="button" className="btn secondary" disabled={saving} onClick={() => {
                  setForm(formOf(ree));
                  setCoverEdit(undefined);
                }}>
                  {s.discard}
                </button>
                <button type="submit" className="btn" disabled={saving}>
                  {saving ? s.saving : s.save}
                </button>
              </div>
              <section className="card setup-danger" aria-labelledby="ree-delete-heading">
                <div>
                  <h2 id="ree-delete-heading">{s.dangerTitle}</h2>
                  <p>{s.dangerBody}</p>
                </div>
                <button type="button" className="btn secondary sm" onClick={() => setConfirmDelete(true)}>
                  <PIcon name="trash" />
                  {s.delete}
                </button>
              </section>
            </div>
            <aside className="card setup-summary" aria-label={s.overview}>
              <div className="setup-summary-identity">
                <p className="setup-summary-label">{s.overview}</p>
                <h2>{form.name.trim() || ree.name}</h2>
                {form.category && <span className="tag blue">{t.common.categories[form.category]}</span>}
                {form.description.trim() && <p className="setup-summary-description">{form.description}</p>}
              </div>
              <div className="setup-summary-links">
                <Link href={`/rees/${ree.id}/knowledge`}>
                  <PIcon name="file" />
                  <span>{s.sources}</span>
                  <span className="setup-source-count">{formatNumber(sources, locale)}</span>
                  <PIcon name="arrow" className="setup-summary-arrow" />
                </Link>
                <Link href={`/rees/${ree.id}/chat`}>
                  <PIcon name="chat" />
                  <span>{s.test}</span>
                  <PIcon name="arrow" className="setup-summary-arrow" />
                </Link>
                {ree.isPublic && ree.isPublished && !moderated && (
                  <Link href={`/r/${ree.slug}`}>
                    <PIcon name="external" />
                    <span>{s.viewPublic}</span>
                    <PIcon name="arrow" className="setup-summary-arrow" />
                  </Link>
                )}
              </div>
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
    </>
  );
}
