'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { DOCUMENT_MAX_BYTES, TEXT_SOURCE_LIMITS } from '@/lib/constants';
import { holdFor, validDocument } from '@/lib/domain/knowledge';
import { validateDraftSource, validateReeFields, type ReeDraft, type SourceChoice } from '@/lib/domain/ree';
import { api, uploadToBlob } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatBytes } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { Icon, Spinner } from '@/components/ui/icons';
import { ConfirmModal } from '@/components/ui/modal';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import { Field, IdentityFields, PersonalityFields, PublishingFields, type ReeFormState } from '@/components/rees/ree-fields';

type Message = keyof ReturnType<typeof useI18n>['t']['reeSetup']['messages'];

/**
 * `/rees/new`: four steps -- identity, knowledge & personality, first
 * knowledge, publish & review (prototype dot-setup.js). Every step change
 * saves the draft to `user.ree_draft`, so leaving and coming back (on any
 * device) resumes it; only the final confirmation creates the Ree.
 */
export function SetupWizard({ initialDraft }: { initialDraft: ReeDraft }) {
  const { t, locale } = useI18n();
  const w = t.reeSetup.wizard;
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<ReeDraft>(initialDraft);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [restart, setRestart] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const step = draft.step;

  const patch = (changes: Partial<ReeDraft>) => setDraft((current) => ({ ...current, ...changes }));
  const patchSource = (changes: Partial<ReeDraft['source']>) => setDraft((current) => ({ ...current, source: { ...current.source, ...changes } }));
  const form: ReeFormState = draft;

  const save = async (next: ReeDraft) => {
    const result = await api<{ draft: ReeDraft }>('/api/rees/draft', { method: 'PUT', json: { draft: next } });
    return result.ok;
  };

  const goTo = async (target: number, base: ReeDraft = draft) => {
    const next = { ...base, step: target, reached: Math.max(base.reached, target) };
    setDraft(next);
    setError('');
    await save(next);
    router.replace(`/rees/new?step=${target}`, { scroll: false });
    window.scrollTo({ top: 0 });
  };

  const invalidFor = (upTo: number): { step: number; message: Message } | null => {
    const fields = { ...draft, tags: draft.tags };
    const invalid = validateReeFields(fields, upTo >= 4 ? 4 : Math.min(upTo, 2));
    if (invalid) return { step: invalid.step, message: invalid.error };
    if (upTo >= 3) {
      const source = validateDraftSource(draft.source);
      if (source) return { step: 3, message: source };
    }
    return null;
  };

  const next = async () => {
    const invalid = invalidFor(step);
    if (invalid) {
      setError(t.reeSetup.messages[invalid.message]);
      if (invalid.step < step) {
        const back = { ...draft, step: invalid.step };
        setDraft(back);
        await save(back);
        router.replace(`/rees/new?step=${invalid.step}`, { scroll: false });
      }
      return;
    }
    if (step < 4) return goTo(step + 1);
    setBusy(true);
    await save(draft);
    const result = await api<{ id?: string; knowledgeId?: string | null; error?: string; step?: number }>('/api/rees', { method: 'POST' });
    if (result.ok && result.data.id) {
      toast(w.created);
      router.push(`/rees/${result.data.id}/${result.data.knowledgeId ? 'knowledge' : 'settings'}`);
      router.refresh();
      return;
    }
    setBusy(false);
    const code = result.data.error ?? '';
    if (result.status === 402) setError(t.reeSetup.messages.insufficient);
    else if (code in t.reeSetup.messages) setError(t.reeSetup.messages[code as Message]);
    else if (code === 'invalid_document' || code === 'upload_missing') setError(t.reeSetup.messages['file-format']);
    else if (code === 'invalid_text') setError(t.reeSetup.messages['source-text']);
    else setError(t.common.errors.generic);
    if (result.data.step && result.data.step < 4) await goTo(result.data.step);
  };

  const exit = async () => {
    await save(draft);
    toast(w.draftSaved);
    router.push('/rees');
  };

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (!validDocument(file.name, file.size) || file.size > DOCUMENT_MAX_BYTES) {
      setError(t.reeSetup.messages['file-format']);
      return;
    }
    setUploading(true);
    const result = await uploadToBlob(file, { purpose: 'document', fileName: file.name, size: file.size });
    setUploading(false);
    if ('error' in result) {
      setError(t.reeSetup.messages.upload);
      return;
    }
    const nextDraft = { ...draft, source: { ...draft.source, fileName: file.name, fileSize: file.size, blobPath: result.pathname } };
    setDraft(nextDraft);
    await save(nextDraft);
  };

  const estimated = draft.source.kind === 'later' ? 0 : draft.source.kind === 'text' ? holdFor('text', draft.source.text) : holdFor('document');
  const sourceLabel =
    draft.source.kind === 'later'
      ? w.sourceKinds.later
      : draft.source.kind === 'text'
        ? draft.source.title || w.sourceKinds.text
        : draft.source.fileName || w.sourceKinds.document;

  const progress = (
    <nav aria-label={w.progress} className="flex items-stretch gap-1">
      {w.steps.map((label, index) => {
        const number = index + 1;
        const reachable = number <= draft.reached;
        return (
          <button
            key={label}
            type="button"
            disabled={!reachable || busy}
            aria-current={number === step ? 'step' : undefined}
            onClick={() => reachable && goTo(number)}
            className={`flex flex-none items-center gap-2 border-b-2 px-3 text-[12px] font-medium whitespace-nowrap disabled:opacity-50 ${
              number === step ? 'border-blue text-blue' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            <span
              className={`inline-flex size-5 items-center justify-center rounded-full font-mono text-[10px] ${
                number < step ? 'bg-blue text-white' : number === step ? 'bg-soft text-blue' : 'bg-wash text-muted'
              }`}
            >
              {number < step ? <Icon name="check" className="size-3" /> : number}
            </span>
            {label}
          </button>
        );
      })}
    </nav>
  );

  return (
    <>
      <Topbar
        crumbs={[{ label: t.dashboard.title, href: '/dashboard' }, { label: t.rees.title, href: '/rees' }, { label: w.title }]}
        secondRow={progress}
      />
      <main className="mx-auto max-w-[1180px] px-4 py-8 md:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">{w.eyebrow}</p>
            <h1 className="mt-2 text-[28px] font-extrabold tracking-tight">{w.title}</h1>
            <p className="mt-2 text-[13px] text-muted">{w.lede}</p>
          </div>
          <button type="button" className="btn-secondary btn-sm" onClick={exit} disabled={busy}>
            {w.saveExit}
          </button>
        </div>
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <form
            className="card p-5 sm:p-7"
            onSubmit={(event) => {
              event.preventDefault();
              void next();
            }}
            noValidate
          >
            <div className="flex items-baseline gap-3 border-b border-line pb-4">
              <span className="font-mono text-[11px] text-muted">{fill(w.stepOf, { step })}</span>
              <h2 className="text-[17px] font-bold">{w.steps[step - 1]}</h2>
            </div>
            {error && (
              <p role="alert" className="mt-4 rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">
                {error}
              </p>
            )}
            <div className="mt-2">
              {step === 1 && <IdentityFields value={form} onChange={patch} />}
              {step === 2 && <PersonalityFields value={form} onChange={patch} />}
              {step === 3 && (
                <>
                  <Field id="source-kind" label={w.sourceLabel}>
                    <select
                      id="source-kind"
                      className="input"
                      value={draft.source.kind}
                      onChange={(event) => patchSource({ kind: event.target.value as SourceChoice })}
                    >
                      {(['later', 'document', 'text'] as const).map((kind) => (
                        <option key={kind} value={kind}>
                          {w.sourceKinds[kind]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {draft.source.kind === 'later' && (
                    <div className="mt-5 flex flex-col items-center gap-2 rounded-xl border border-dashed border-line bg-wash px-4 py-8 text-center">
                      <Icon name="file" className="size-6 text-blue" />
                      <strong className="text-[14px]">{w.laterTitle}</strong>
                      <p className="max-w-[420px] text-[12px] text-muted">{w.laterBody}</p>
                    </div>
                  )}
                  {draft.source.kind === 'text' && (
                    <>
                      <Field id="source-title" label={w.sourceTitle}>
                        <input
                          id="source-title"
                          className="input"
                          maxLength={TEXT_SOURCE_LIMITS.title}
                          value={draft.source.title}
                          onChange={(event) => patchSource({ title: event.target.value })}
                        />
                      </Field>
                      <Field
                        id="source-text"
                        label={w.sourceText}
                        hint={w.sourceTextHint}
                        counter={fill(t.reeSetup.fields.counter, { count: draft.source.text.length, max: TEXT_SOURCE_LIMITS.content })}
                      >
                        <textarea
                          id="source-text"
                          className="input min-h-[180px] resize-y"
                          rows={8}
                          maxLength={TEXT_SOURCE_LIMITS.content}
                          value={draft.source.text}
                          onChange={(event) => patchSource({ text: event.target.value })}
                        />
                      </Field>
                    </>
                  )}
                  {draft.source.kind === 'document' && (
                    <div className="mt-5 rounded-xl border border-dashed border-[#c9d6ee] bg-wash p-5">
                      <div className="flex flex-wrap items-center gap-3">
                        <button type="button" className="btn-secondary btn-sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
                          {uploading ? <Spinner className="size-3.5" /> : <Icon name="upload" className="size-3.5" />}
                          {uploading ? w.fileUploading : w.fileChoose}
                        </button>
                        <span className="min-w-0 truncate text-[13px] font-medium">
                          {draft.source.fileName ? `${draft.source.fileName} · ${formatBytes(draft.source.fileSize)}` : w.fileNone}
                        </span>
                      </div>
                      <small className="hint">
                        {w.fileLimits}
                        {draft.source.blobPath && ` · ${w.fileUploaded}`}
                      </small>
                      <input
                        ref={fileRef}
                        type="file"
                        hidden
                        accept=".pdf,.docx,.md,.txt"
                        onChange={(event) => {
                          void chooseFile(event.target.files?.[0]);
                          event.target.value = '';
                        }}
                      />
                    </div>
                  )}
                  <div className="mt-6 flex gap-2 rounded-lg bg-soft px-3 py-2.5 text-[12px] text-[#3b4361]">
                    <Icon name="info" className="mt-0.5 size-4 flex-none text-blue" />
                    {w.noCharge}
                  </div>
                </>
              )}
              {step === 4 && (
                <>
                  <div className="mt-5">
                    <PublishingFields value={form} onChange={patch} />
                  </div>
                  <section className="mt-6 rounded-xl border border-line bg-wash p-5">
                    <h3 className="text-[14px] font-bold">{w.reviewTitle}</h3>
                    <div className="mt-3 flex items-center gap-3">
                      <ReeAvatar avatar={draft.avatarBlob} color={draft.color} />
                      <strong className="min-w-0 truncate text-[14px]">{draft.name}</strong>
                      {draft.category && <span className="tag">{t.common.categories[draft.category]}</span>}
                    </div>
                    {draft.description && <p className="mt-3 text-[12px] text-muted">{draft.description}</p>}
                    <dl className="mt-4 grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-3">
                      <div>
                        <dt className="text-muted">{w.reviewTags}</dt>
                        <dd className="mt-1 font-medium">{draft.tags.join(' · ') || '—'}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-muted">{w.reviewSource}</dt>
                        <dd className="mt-1 truncate font-medium">{sourceLabel}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">{w.reviewCost}</dt>
                        <dd className="mt-1 font-mono font-medium">
                          {estimated ? fill(w.reviewCostValue, { credits: estimated.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') }) : '0 credits'}
                        </dd>
                      </div>
                    </dl>
                    <small className="hint mt-3">{w.reviewNote}</small>
                  </section>
                </>
              )}
            </div>
            <div className="mt-8 flex items-center justify-between gap-3 border-t border-line pt-5">
              {step > 1 ? (
                <button type="button" className="btn-secondary" onClick={() => goTo(step - 1)} disabled={busy}>
                  <Icon name="arrowLeft" />
                  {w.prev}
                </button>
              ) : (
                <Link href="/rees" className="text-link text-[12px]">
                  {w.backToList}
                </Link>
              )}
              <button type="submit" className="btn" disabled={busy || uploading}>
                {busy ? <Spinner /> : null}
                {step === 4 ? (busy ? w.creating : w.create) : w.next}
                {!busy && <Icon name={step === 4 ? 'check' : 'arrow'} />}
              </button>
            </div>
          </form>
          <aside className="card h-fit p-6 lg:sticky lg:top-[124px]">
            <ReeAvatar size="lg" color={draft.color} avatar={draft.avatarBlob} />
            <h2 className="mt-5 text-[19px] leading-snug font-bold">{w.notes[step - 1]}</h2>
            <p className="mt-3 text-[12px] leading-relaxed text-muted">{w.noteBody}</p>
            <button type="button" className="btn-ghost mt-4 -ml-2" onClick={() => setRestart(true)} disabled={busy}>
              <Icon name="refresh" className="size-3.5" />
              {w.restart}
            </button>
          </aside>
        </div>
      </main>
      <ConfirmModal
        open={restart}
        title={w.restartTitle}
        body={w.restartBody}
        confirmLabel={w.restart}
        onClose={() => setRestart(false)}
        onConfirm={async () => {
          setRestart(false);
          const result = await api<{ draft: ReeDraft }>('/api/rees/draft', { method: 'DELETE' });
          if (result.ok) setDraft(result.data.draft);
          setError('');
          router.replace('/rees/new?step=1', { scroll: false });
        }}
      />
    </>
  );
}
