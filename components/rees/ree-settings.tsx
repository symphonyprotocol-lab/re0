'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { validateReeFields, type ReeFieldError } from '@/lib/domain/ree';
import type { ReeCategory, ReeColor } from '@/lib/constants';
import type { Ree } from '@/lib/services/rees';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { ConfirmModal } from '@/components/ui/modal';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import { IdentityFields, PersonalityFields, PublishingFields, type ReeFormState } from '@/components/rees/ree-fields';

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

  const saveButton = (
    <button type="submit" className="btn" disabled={saving}>
      {saving ? <Spinner /> : <Icon name="check" />}
      {saving ? s.saving : s.save}
    </button>
  );

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-8 md:px-8">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[26px] font-extrabold tracking-tight">{s.title}</h1>
            <p className="mt-2 text-[13px] text-muted">{s.lede}</p>
          </div>
          {saveButton}
        </div>
        {error && (
          <p role="alert" className="mt-4 rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">
            {error}
          </p>
        )}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-6">
            <section className="card p-5 sm:p-7">
              <h2 className="text-[16px] font-bold">{s.identity}</h2>
              <div className="mt-2">
                <IdentityFields value={form} onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} onCropping={setCropping} />
              </div>
            </section>
            <section className="card p-5 sm:p-7">
              <h2 className="text-[16px] font-bold">{s.personality}</h2>
              <PersonalityFields value={form} onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} />
              {/* Step 4: the system's three suggestions, shown publicly only once adopted here and saved (8.2, "示例问题"). */}
              {!form.sampleQuestions.trim() && ree.suggestedQuestions.length > 0 && (
                <div className="mt-4 rounded-xl border border-dashed border-[#c9dcf5] bg-soft p-4">
                  <strong className="flex items-center gap-1.5 text-[12px]">
                    <Icon name="sparkle" className="size-3.5 text-blue" />
                    {t.discover.settings.suggestedTitle}
                  </strong>
                  <p className="mt-1 text-[11px] text-muted">{t.discover.settings.suggestedBody}</p>
                  <ol className="mt-2 list-decimal pl-5 text-[12px]">
                    {ree.suggestedQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ol>
                  <button
                    type="button"
                    className="btn-secondary btn-sm mt-3"
                    onClick={() => {
                      setForm((current) => ({ ...current, sampleQuestions: ree.suggestedQuestions.join('\n') }));
                      toast(t.discover.settings.adopted);
                    }}
                  >
                    <Icon name="check" className="size-3.5" />
                    {t.discover.settings.adopt}
                  </button>
                </div>
              )}
            </section>
            <section className="card p-5 sm:p-7">
              <h2 className="text-[16px] font-bold">{s.publishing}</h2>
              <div className="mt-5">
                <PublishingFields value={form} onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} moderated={moderated} />
              </div>
            </section>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setForm(formOf(ree))}>
                {s.discard}
              </button>
              {saveButton}
            </div>
          </div>
          <aside className="flex flex-col gap-4">
            <section className="card flex flex-col gap-3 p-5">
              <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="lg" />
              <h2 className="text-[17px] font-bold break-words">{ree.name}</h2>
              <span className="tag w-fit border-[#d8e6fb] bg-soft text-blue">{t.common.categories[ree.category as ReeCategory]}</span>
              {ree.description && <p className="text-[12px] text-muted">{ree.description}</p>}
              <Link href={`/rees/${ree.id}/knowledge`} className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5 text-[12px] font-semibold hover:border-blue hover:text-blue">
                <span className="flex items-center gap-2">
                  <Icon name="file" />
                  {fill(s.sources, { count: sources })}
                </span>
                <Icon name="arrow" className="size-3.5" />
              </Link>
              <Link href={`/rees/${ree.id}/chat`} className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5 text-[12px] font-semibold hover:border-blue hover:text-blue">
                <span className="flex items-center gap-2">
                  <Icon name="chat" />
                  {s.test}
                </span>
                <Icon name="arrow" className="size-3.5" />
              </Link>
              {ree.isPublic && !moderated && (
                <Link href={`/r/${ree.slug}`} className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5 text-[12px] font-semibold hover:border-blue hover:text-blue">
                  <span className="flex items-center gap-2">
                    <Icon name="external" />
                    {s.viewPublic}
                  </span>
                  <Icon name="arrow" className="size-3.5" />
                </Link>
              )}
              <small className="text-[11px] text-muted">{s.summaryNote}</small>
            </section>
            <section className="card p-5">
              <h3 className="text-[14px] font-bold">{s.dangerTitle}</h3>
              <p className="mt-1 text-[12px] text-muted">{s.dangerBody}</p>
              <button type="button" className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-red hover:underline" onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" className="size-3.5" />
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
