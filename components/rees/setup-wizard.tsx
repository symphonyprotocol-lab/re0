'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useSearchParams } from 'next/navigation';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useEffect, useRef, useState } from 'react';
import { validateReeFields, type ReeDraft } from '@/lib/domain/ree';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { ConfirmModal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { IdentityFields, PersonalityFields, PublishingFields, type ReeFormState } from '@/components/rees/ree-fields';
import { DotAvatar, PIcon } from '@/components/rees/proto-icon';
import './ree-pages.css';
import './ree-setup.css';

type Message = keyof ReturnType<typeof useI18n>['t']['reeSetup']['messages'];

/**
 * `/rees/new`: three steps -- identity, knowledge & personality,
 * publish & review (prototype dot-setup.js). Every step change
 * saves the draft to `user.ree_draft`, so leaving and coming back (on any
 * device) resumes it; only the final confirmation creates the Ree. Each step
 * is its own history entry (`?step=`), so the browser's back and forward walk
 * the steps, never past the furthest one reached.
 */
export function SetupWizard({ initialDraft }: { initialDraft: ReeDraft }) {
  const { t } = useI18n();
  const w = t.reeSetup.wizard;
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<ReeDraft>(initialDraft);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
  const form: ReeFormState = draft;

  const save = async (next: ReeDraft) => {
    const result = await api<{ draft?: ReeDraft; error?: string }>('/api/rees/draft', { method: 'PUT', json: { draft: next } });
    return result.ok ? null : (result.data.error ?? 'generic');
  };

  const showError = (code: string) => {
    setError(code in t.reeSetup.messages ? t.reeSetup.messages[code as Message] : t.common.errors.generic);
  };

  /* Every history entry names its step: the first one gets it without a new entry. */
  useEffect(() => {
    if (!search.get('step')) router.replace(`/rees/new?step=${draftRef.current.step}`, { scroll: false });
  }, [search, router]);

  /* Back / forward: the address changed under the wizard; show that step (capped at the furthest reached) and save it. */
  useEffect(() => {
    const current = draftRef.current;
    if (!Number.isInteger(urlStep) || urlStep < 1) return;
    const target = Math.min(urlStep, current.reached, 3);
    if (target !== urlStep) router.replace(`/rees/new?step=${target}`, { scroll: false });
    if (target === current.step) return;
    const moved = { ...current, step: target };
    setDraft(moved);
    setError('');
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
    setDraft(next);
    setError('');
    await save(next);
    router.push(`/rees/new?step=${target}`, { scroll: false });
    window.scrollTo({ top: 0 });
  };

  const invalidFor = (upTo: number): { step: number; message: Message } | null => {
    const invalid = validateReeFields(draft, upTo);
    return invalid ? { step: invalid.step, message: invalid.error } : null;
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
    if (step < 3) return goTo(step + 1);
    setBusy(true);
    await save(draft);
    const result = await api<{ id?: string; error?: string; step?: number }>('/api/rees', { method: 'POST' });
    if (result.ok && result.data.id) {
      toast(w.created);
      router.push(`/rees/${result.data.id}/settings`);
      router.refresh();
      return;
    }
    setBusy(false);
    const code = result.data.error ?? '';
    /* Back to the step at fault first: moving clears the message, so it is shown after. */
    if (result.data.step && result.data.step < 3) await goTo(result.data.step);
    showError(code);
  };

  const exit = async () => {
    if (cropBlocks()) return;
    await save(draft);
    toast(w.draftSaved);
    router.push('/rees');
  };

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
        </dl>
        <small>{w.reviewNote}</small>
      </div>
    </>
  );

  return (
    <>
      <Topbar
        crumbs={[{ label: t.rees.title, href: '/rees' }, { label: w.crumb }]}
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
                  {error}
                </p>
              )}
              {step === 1 && <IdentityFields value={form} onChange={patch} onCropping={setCropping} />}
              {step === 2 && <PersonalityFields value={form} onChange={patch} />}
              {step === 3 && review}
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
                <button type="submit" className="btn" disabled={busy}>
                  {step === 3 ? (busy ? w.creating : w.create) : w.next}
                  <PIcon name={step === 3 ? 'check' : 'arrow'} />
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
