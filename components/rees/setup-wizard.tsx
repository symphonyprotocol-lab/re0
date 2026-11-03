'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { KNOWLEDGE_URL_MAX, TEXT_SOURCE_LIMITS } from '@/lib/constants';
import { holdFor, validAudio, validDocument } from '@/lib/domain/knowledge';
import { SOURCE_CHOICES, validateDraftSource, validateReeFields, type ReeDraft, type SourceChoice } from '@/lib/domain/ree';
import { api, uploadToBlob } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatBytes, formatNumber } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { ConfirmModal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { Field, IdentityFields, PersonalityFields, PublishingFields, type ReeFormState } from '@/components/rees/ree-fields';
import { DotAvatar, PIcon } from '@/components/rees/proto-icon';
import './ree-pages.css';
import './ree-setup.css';

type Message = keyof ReturnType<typeof useI18n>['t']['reeSetup']['messages'];

/** Server refusals of a first source, as the wizard's own messages (prototype dot-setup.js errors). */
const SOURCE_REFUSALS: Record<string, Message> = {
  invalid_document: 'file-format',
  invalid_audio: 'file-format',
  upload_missing: 'file',
  consent_required: 'audio-consent',
  invalid_text: 'source-text',
  invalid_url: 'url',
  invalid_github_url: 'github-url',
  github_not_connected: 'github-auth',
  github_repo_not_found: 'github-missing',
  domain_unverified: 'domain',
  source_unreachable: 'unreachable',
};

/**
 * `/rees/new`: four steps -- identity, knowledge & personality, first
 * knowledge, publish & review (prototype dot-setup.js). Every step change
 * saves the draft to `user.ree_draft`, so leaving and coming back (on any
 * device) resumes it; only the final confirmation creates the Ree. Each step
 * is its own history entry (`?step=`), so the browser's back and forward walk
 * the steps, never past the furthest one reached.
 */
export function SetupWizard({ initialDraft }: { initialDraft: ReeDraft }) {
  const { t, locale } = useI18n();
  const w = t.reeSetup.wizard;
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<ReeDraft>(initialDraft);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [connectLink, setConnectLink] = useState(false);
  const [restart, setRestart] = useState(false);
  const [cropping, setCropping] = useState(false);
  const step = draft.step;
  const search = useSearchParams();
  const urlStep = Number(search.get('step'));
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  });

  const patch = (changes: Partial<ReeDraft>) => setDraft((current) => ({ ...current, ...changes }));
  const patchSource = (changes: Partial<ReeDraft['source']>) => setDraft((current) => ({ ...current, source: { ...current.source, ...changes } }));
  const form: ReeFormState = draft;

  const save = async (next: ReeDraft, checkSource = false) => {
    const result = await api<{ draft?: ReeDraft; error?: string }>('/api/rees/draft', { method: 'PUT', json: { draft: next, checkSource } });
    return result.ok ? null : (result.data.error ?? 'generic');
  };

  const showError = (code: string) => {
    const message = SOURCE_REFUSALS[code];
    setError(message ? t.reeSetup.messages[message] : code in t.reeSetup.messages ? t.reeSetup.messages[code as Message] : t.common.errors.generic);
    setConnectLink(code === 'github_not_connected' || code === 'domain_unverified');
  };

  /* Every history entry names its step: the first one gets it without a new entry. */
  useEffect(() => {
    if (!search.get('step')) router.replace(`/rees/new?step=${draftRef.current.step}`, { scroll: false });
  }, [search, router]);

  /* Back / forward: the address changed under the wizard; show that step (capped at the furthest reached) and save it. */
  useEffect(() => {
    const current = draftRef.current;
    if (!Number.isInteger(urlStep) || urlStep < 1) return;
    const target = Math.min(urlStep, current.reached, 4);
    if (target !== urlStep) router.replace(`/rees/new?step=${target}`, { scroll: false });
    if (target === current.step) return;
    const moved = { ...current, step: target };
    setDraft(moved);
    setError('');
    setConnectLink(false);
    void save(moved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only an address change moves the wizard here
  }, [urlStep]);

  /** An open avatar crop is neither saved nor left behind (prototype dot-avatar.js `beforeSubmit`). */
  const cropBlocks = () => {
    if (!cropping) return false;
    setError(t.reeSetup.messages.crop);
    return true;
  };

  const goTo = async (target: number, base: ReeDraft = draft) => {
    if (cropBlocks()) return;
    const next = { ...base, step: target, reached: Math.max(base.reached, target) };
    /* Leaving step 3 checks the source against GitHub and the domain claims first. */
    if (base.step === 3 && target === 4) {
      setBusy(true);
      const refused = await save(next, true);
      setBusy(false);
      if (refused) return showError(refused);
    }
    setDraft(next);
    setError('');
    setConnectLink(false);
    await save(next);
    router.push(`/rees/new?step=${target}`, { scroll: false });
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
    if (cropBlocks()) return;
    const invalid = invalidFor(step);
    if (invalid) {
      setError(t.reeSetup.messages[invalid.message]);
      if (invalid.step < step) {
        const back = { ...draft, step: invalid.step };
        setDraft(back);
        await save(back);
        router.push(`/rees/new?step=${invalid.step}`, { scroll: false });
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
    /* Back to the step at fault first: moving clears the message, so it is shown after. */
    if (result.data.step && result.data.step < 4) await goTo(result.data.step);
    if (result.status === 402) setError(t.reeSetup.messages.insufficient);
    else showError(code);
  };

  const exit = async () => {
    if (cropBlocks()) return;
    await save(draft);
    toast(w.draftSaved);
    router.push('/rees');
  };

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    const audio = draft.source.kind === 'audio';
    if (!(audio ? validAudio : validDocument)(file.name, file.size)) {
      setError(t.reeSetup.messages['file-format']);
      return;
    }
    setUploading(0);
    const result = await uploadToBlob(file, { purpose: audio ? 'audio' : 'document', fileName: file.name, size: file.size }, setUploading);
    setUploading(null);
    if ('error' in result) {
      setError(t.reeSetup.messages.upload);
      return;
    }
    const nextDraft = { ...draft, source: { ...draft.source, fileName: file.name, fileSize: file.size, blobPath: result.pathname } };
    setDraft(nextDraft);
    await save(nextDraft);
  };

  const source = draft.source;
  const estimated =
    source.kind === 'later' ? 0 : source.kind === 'text' ? holdFor('text', source.text) : source.kind === 'audio' ? holdFor('audio', source.fileSize) : holdFor(source.kind);
  const sourceLabel =
    source.kind === 'later'
      ? w.sourceKinds.later
      : source.kind === 'text'
        ? source.title || w.sourceKinds.text
        : source.kind === 'document' || source.kind === 'audio'
          ? source.fileName || w.sourceKinds[source.kind]
          : source.url || w.sourceKinds[source.kind];
  const fileKind = source.kind === 'document' || source.kind === 'audio';

  const progress = (
    <nav className="setup-progress" aria-label={w.progress}>
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
          >
            <span>{number < step ? <PIcon name="check" /> : number}</span>
            {label}
          </button>
        );
      })}
    </nav>
  );

  const sourceFields = (
    <>
      <Field id="setup-source-kind" label={w.sourceLabel}>
        <select
          id="setup-source-kind"
          name="source-kind"
          value={source.kind}
          onChange={(event) => patchSource({ kind: event.target.value as SourceChoice, fileName: '', fileSize: 0, blobPath: '' })}
        >
          {SOURCE_CHOICES.map((kind) => (
            <option key={kind} value={kind}>
              {w.sourceKinds[kind]}
            </option>
          ))}
        </select>
      </Field>
      {source.kind === 'later' ? (
        <div className="setup-source-later">
          <PIcon name="file" />
          <h3>{w.laterTitle}</h3>
          <p>{w.laterBody}</p>
        </div>
      ) : source.kind === 'text' ? (
        <>
          <Field id="setup-source-title" label={w.sourceTitle}>
            <input
              id="setup-source-title"
              name="source-title"
              maxLength={TEXT_SOURCE_LIMITS.title}
              required
              value={source.title}
              onChange={(event) => patchSource({ title: event.target.value })}
            />
          </Field>
          <Field id="setup-source-text" label={w.sourceText} hint={w.sourceTextHint}>
            <textarea
              id="setup-source-text"
              name="source-text"
              rows={8}
              maxLength={TEXT_SOURCE_LIMITS.content}
              required
              value={source.text}
              onChange={(event) => patchSource({ text: event.target.value })}
            />
          </Field>
        </>
      ) : fileKind ? (
        /* The file is uploaded as soon as it is chosen, so the draft keeps it across a refresh. */
        <div className="setup-file">
          <input
            type="file"
            id="setup-source-file"
            accept={source.kind === 'audio' ? '.mp3,.m4a,.wav' : '.pdf,.docx,.md,.txt'}
            disabled={uploading !== null}
            onChange={(event) => {
              void chooseFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
          <p>{uploading !== null ? `${w.fileUploading} ${uploading}%` : source.fileName ? `${source.fileName} · ${formatBytes(source.fileSize)}` : w.fileNone}</p>
          <small>
            {source.kind === 'audio' ? w.audioLimits : w.fileLimits}
            {source.blobPath && ` · ${w.fileUploaded}`}
          </small>
        </div>
      ) : (
        <>
          <Field id="setup-source-url" label={w.sourceUrl}>
            <input
              id="setup-source-url"
              name="source-url"
              type="url"
              inputMode="url"
              maxLength={KNOWLEDGE_URL_MAX}
              placeholder={source.kind === 'github' ? 'https://github.com/owner/repo' : 'https://'}
              required
              value={source.url}
              onChange={(event) => patchSource({ url: event.target.value })}
            />
          </Field>
          {source.kind !== 'page' && <p className="form-hint">{source.kind === 'github' ? w.githubHint : w.siteHint}</p>}
        </>
      )}
      {source.kind === 'audio' && (
        <label className="check-row setup-audio-consent">
          <input type="checkbox" name="audio-consent" required checked={source.consent} onChange={(event) => patchSource({ consent: event.target.checked })} />
          {w.audioConsent}
        </label>
      )}
      <div className="info-strip mt24">
        <PIcon name="info" />
        <span>{w.noCharge}</span>
      </div>
    </>
  );

  const review = (
    <>
      <PublishingFields value={form} onChange={patch} />
      <div className="setup-review">
        <h3>{w.reviewTitle}</h3>
        <div>
          <DotAvatar avatar={draft.avatarBlob} color={draft.color} />
          <strong>{draft.name}</strong>
          {draft.category && <span className="tag">{t.common.categories[draft.category]}</span>}
        </div>
        <p>{draft.description}</p>
        <dl>
          <div>
            <dt>{w.reviewTags}</dt>
            <dd>{draft.tags.join(' · ') || '—'}</dd>
          </div>
          <div>
            <dt>{w.reviewSource}</dt>
            <dd>{sourceLabel}</dd>
          </div>
          <div>
            <dt>{w.reviewCost}</dt>
            <dd>{fill(w.reviewCostValue, { credits: formatNumber(estimated, locale) })}</dd>
          </div>
        </dl>
        <small>{w.reviewNote}</small>
      </div>
    </>
  );

  return (
    <>
      <Topbar
        crumbs={[{ label: t.dashboard.title, href: '/dashboard' }, { label: t.rees.title, href: '/rees' }, { label: w.crumb }]}
        secondRow={progress}
      />
      <main className="page dot-setup-page">
        <div className="setup-page-heading">
          <div>
            <p className="eyebrow">{w.eyebrow}</p>
            <h1>{w.title}</h1>
            <p>{w.lede}</p>
          </div>
          <button type="button" className="btn secondary sm" onClick={exit} disabled={busy}>
            {w.saveExit}
          </button>
        </div>
        <div className="setup-wizard-grid">
          <form
            id="dot-setup-form"
            data-step={step}
            onSubmit={(event) => {
              event.preventDefault();
              void next();
            }}
            noValidate
          >
            <section className="card setup-section">
              <div className="setup-step-title">
                <span>{fill(w.stepOf, { step })}</span>
                <h2>{w.steps[step - 1]}</h2>
              </div>
              {error && (
                <p className="form-error" role="alert">
                  {error}{' '}
                  {connectLink && (
                    <Link href="/settings?tab=connections" className="underline">
                      {w.connections}
                    </Link>
                  )}
                </p>
              )}
              {step === 1 && <IdentityFields value={form} onChange={patch} onCropping={setCropping} />}
              {step === 2 && <PersonalityFields value={form} onChange={patch} />}
              {step === 3 && sourceFields}
              {step === 4 && review}
              <div className="setup-step-actions">
                {step > 1 ? (
                  <button type="button" className="btn secondary" onClick={() => goTo(step - 1)} disabled={busy}>
                    <PIcon name="arrow" />
                    {w.prev}
                  </button>
                ) : (
                  <Link href="/rees" className="text-link">
                    {w.backToList}
                  </Link>
                )}
                <button type="submit" className="btn" disabled={busy || uploading !== null}>
                  {step === 4 ? (busy ? w.creating : w.create) : w.next}
                  <PIcon name={step === 4 ? 'check' : 'arrow'} />
                </button>
              </div>
            </section>
          </form>
          <aside className="setup-wizard-note">
            <span>
              <PIcon name="dot" />
            </span>
            <h2>{w.notes[step - 1]}</h2>
            <p>{w.noteBody}</p>
            <button type="button" className="text-link" onClick={() => setRestart(true)} disabled={busy}>
              <PIcon name="refresh" />
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
