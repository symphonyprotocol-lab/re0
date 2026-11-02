'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { VIDEO_ASPECTS, VIDEO_LIMITS, VIDEO_SCRIPT_CREDITS, VIDEO_SHOT_SECONDS, VIDEO_TEMPLATES, type VideoAspect, type VideoTemplate } from '@/lib/constants';
import { chars, isAccent, sceneErrors, type IntroProps, type SceneError, type SceneField, type VideoScenes } from '@/lib/domain/video';
import { api } from '@/lib/client/upload';
import { PALETTES } from '@/video/theme';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { VideoPlaceholder, type CoverRee } from '@/components/video/video-cover';
import { ExportPanel, type LastExport } from '@/components/video/export-panel';

const IntroPlayer = dynamic(() => import('@/components/video/intro-player').then((module) => module.IntroPlayer), {
  ssr: false,
  loading: () => <div className="aspect-video w-full animate-pulse rounded-[10px] bg-soft" />,
});

export interface SavedVideo {
  generated: boolean;
  revision: number;
  template: VideoTemplate;
  accentColor: string;
  aspect: VideoAspect;
  music: boolean;
  scenes: VideoScenes | null;
  exportsCount: number;
}

interface Draft {
  template: VideoTemplate;
  accent: string;
  aspect: VideoAspect;
  music: boolean;
  name: string;
  position: string;
  sources: string;
  question: string;
  answer: string;
  cta: string;
}

function draftOf(video: SavedVideo): Draft {
  const scenes = video.scenes;
  return {
    template: video.template,
    accent: video.accentColor,
    aspect: video.aspect,
    music: video.music,
    name: scenes?.opening.name ?? '',
    position: scenes?.opening.position ?? '',
    sources: scenes?.sources.titles.join('\n') ?? '',
    question: scenes?.answer.question ?? '',
    answer: scenes?.answer.answer ?? '',
    cta: scenes?.closing.cta ?? '',
  };
}

function scenesOf(draft: Draft): VideoScenes {
  return {
    opening: { name: draft.name.trim(), position: draft.position.trim() },
    sources: { titles: draft.sources.split('\n').map((line) => line.trim()).filter(Boolean) },
    answer: { question: draft.question.trim(), answer: draft.answer.trim() },
    closing: { cta: draft.cta.trim() },
  };
}

/**
 * `/rees/[id]/video` (prototype suite.js `videoEditor`): generate the
 * four-shot script for 20 credits (only with a ready source), edit each shot
 * within its limit -- an over-limit edit shows its error at once and cannot
 * be saved -- pick a template, accent, aspect and music, preview it in the
 * Player with the shot timeline, then export, share or download the script.
 * The preview follows the unsaved edits; the export uses what is saved.
 */
export function VideoStudio({
  ree,
  readySources,
  initial,
  initialProps,
  lastExport,
}: {
  ree: CoverRee & { id: string; slug: string; isPublic: boolean };
  readySources: number;
  initial: SavedVideo;
  initialProps: IntroProps | null;
  lastExport: LastExport | null;
}) {
  const { t } = useI18n();
  const v = t.video;
  const toast = useToast();
  const router = useRouter();
  const [saved, setSaved] = useState(initial);
  const [savedProps, setSavedProps] = useState(initialProps);
  const [draft, setDraft] = useState(() => draftOf(initial));
  const [busy, setBusy] = useState<'generate' | 'save' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const scenes = useMemo(() => scenesOf(draft), [draft]);
  const errors = saved.generated ? sceneErrors(scenes) : [];
  const dirty = JSON.stringify(draftOf(saved)) !== JSON.stringify(draft);
  const previewProps: IntroProps | null = savedProps
    ? { ...savedProps, template: draft.template, accent: isAccent(draft.accent) ? draft.accent.toLowerCase() : savedProps.accent, aspect: draft.aspect, music: draft.music, scenes: errors.length ? savedProps.scenes : scenes }
    : null;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const fieldName: Record<SceneField, string> = { name: v.panel.name, position: v.panel.position, sources: v.panel.sources, source: v.panel.sources, question: v.panel.question, answer: v.panel.answer, cta: v.panel.cta };
  const messageOf = (error: SceneError) =>
    error.field === 'source'
      ? fill(error.issue === 'empty' ? v.panel.errors.sourceEmpty : v.panel.errors.sourceTooLong, { n: (error.index ?? 0) + 1, max: error.max })
      : error.issue === 'too_many'
        ? fill(v.panel.errors.too_many, { max: error.max })
        : fill(v.panel.errors[error.issue], { field: fieldName[error.field], max: error.max });
  const errorFor = (field: SceneField) => errors.filter((error) => error.field === field || (field === 'sources' && error.field === 'source'));

  const generate = async () => {
    setConfirming(false);
    setBusy('generate');
    setNotice(null);
    const response = await api<{ video?: SavedVideo; props?: IntroProps | null; error?: string }>(`/api/rees/${ree.id}/video/script`, { method: 'POST' });
    setBusy(null);
    if (!response.ok || !response.data.video) {
      const code = response.data.error;
      setNotice(code === 'insufficient_credits' ? v.export.insufficient : code === 'no_ready_source' ? v.needsSource : code === 'script_running' ? v.scriptRunning : v.scriptFailed);
      router.refresh();
      return;
    }
    setSaved(response.data.video);
    setSavedProps(response.data.props ?? null);
    /* A new script replaces the shots; style edits not yet saved stay in the form. */
    setDraft((current) => ({ ...draftOf(response.data.video!), template: current.template, accent: current.accent, aspect: current.aspect, music: current.music }));
    toast(v.generated);
    router.refresh();
  };

  const save = async () => {
    if (errors.length || !isAccent(draft.accent)) {
      setNotice(v.panel.errors.summary);
      return;
    }
    setBusy('save');
    setNotice(null);
    const response = await api<{ video?: SavedVideo; props?: IntroProps | null; error?: string }>(`/api/rees/${ree.id}/video`, {
      method: 'PATCH',
      json: { revision: saved.revision, template: draft.template, accent: draft.accent.toLowerCase(), aspect: draft.aspect, music: draft.music, ...(saved.generated ? { scenes } : {}) },
    }).catch(() => ({ ok: false, status: 0, data: { error: 'network' } as { video?: SavedVideo; props?: IntroProps | null; error?: string } }));
    setBusy(null);
    if (!response.ok || !response.data.video) {
      const code = response.data.error;
      setNotice(code === 'stale' ? v.panel.stale : code === 'scene_limits' ? v.panel.errors.summary : fill(v.panel.saveFailed, { reason: code ?? response.status }));
      return;
    }
    setSaved(response.data.video);
    setSavedProps(response.data.props ?? null);
    setDraft(draftOf(response.data.video));
    toast(v.panel.saved);
  };

  const counter = (value: string, max: number) => {
    const n = chars(value.trim());
    return <span className={`font-mono text-[10px] ${n > max ? 'font-semibold text-red' : 'text-muted'}`}>{fill(v.panel.count, { n, max })}</span>;
  };
  const textField = (key: 'name' | 'position' | 'question' | 'answer' | 'cta', max: number, multiline = false) => {
    const problems = errorFor(key);
    const id = `video-${key}`;
    return (
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label htmlFor={id} className="text-[12px] font-semibold">
            {fieldName[key]}
          </label>
          {counter(draft[key], max)}
        </div>
        {multiline ? (
          <textarea id={id} rows={key === 'answer' ? 3 : 2} className="input resize-y" value={draft[key]} disabled={!saved.generated} aria-invalid={problems.length > 0} aria-describedby={problems.length ? `${id}-error` : undefined} onChange={(event) => set(key, event.target.value)} />
        ) : (
          <input id={id} className="input" value={draft[key]} disabled={!saved.generated} aria-invalid={problems.length > 0} aria-describedby={problems.length ? `${id}-error` : undefined} onChange={(event) => set(key, event.target.value)} />
        )}
        {problems.length > 0 && (
          <p id={`${id}-error`} className="mt-1 text-[11px] text-red" role="alert">
            {problems.map(messageOf).join(' · ')}
          </p>
        )}
      </div>
    );
  };
  const sourceProblems = errorFor('sources');
  const sourceLines = draft.sources.split('\n').filter((line) => line.trim()).length;

  const shotBlock = (index: number, children: React.ReactNode) => (
    <details className="group rounded-lg border border-line" open={index === 0}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[13px] font-semibold">
        <span className="font-mono text-[11px] text-muted">0{index + 1}</span>
        {v.shots[index]}
        <small className="font-normal text-muted">{fill(v.shotLength, { n: VIDEO_SHOT_SECONDS[index]! })}</small>
        <Icon name="chevronDown" className="ml-auto size-4 text-muted transition group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-3 border-t border-line px-3 py-3">{children}</div>
    </details>
  );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-extrabold tracking-tight sm:text-[28px]">{v.heading}</h1>
          <p className="mt-1 text-[13px] text-muted">{fill(v.lede, { name: ree.name })}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button type="button" className="btn-secondary" disabled={readySources === 0 || busy !== null} onClick={() => setConfirming(true)}>
            {busy === 'generate' ? <Spinner /> : <Icon name="sparkle" />}
            {busy === 'generate' ? v.generating : fill(saved.generated ? v.regenerate : v.generate, { n: VIDEO_SCRIPT_CREDITS })}
          </button>
          {readySources === 0 && (
            <p className="text-right text-[11px] text-muted">
              {v.needsSource}{' '}
              <Link href={`/rees/${ree.id}/knowledge`} className="text-link">
                {v.addKnowledge}
              </Link>
            </p>
          )}
        </div>
      </header>

      {notice && (
        <p className="rounded-lg border border-[#f1d4d4] bg-[#fff6f6] px-4 py-3 text-[12px] text-red" role="alert">
          {notice}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(300px,1fr)]">
        <section className="flex min-w-0 flex-col gap-5">
          <div className="card p-3">
            {previewProps ? (
              <IntroPlayer key={previewProps.aspect} props={previewProps} name={ree.name} timeline />
            ) : (
              <div className="overflow-hidden rounded-[10px] border border-line">
                <VideoPlaceholder ree={ree} />
              </div>
            )}
          </div>
          {!previewProps && <p className="hint -mt-3">{v.placeholderHint}</p>}
          <ExportPanel ree={ree} props={savedProps} dirty={dirty} exportsCount={saved.exportsCount} lastExport={lastExport} onExported={(count) => setSaved((current) => ({ ...current, exportsCount: count }))} />
        </section>

        <aside className="card h-fit p-5" aria-label={v.panel.title}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            className="flex flex-col gap-4"
            noValidate
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[16px] font-bold">{v.panel.title}</h2>
              <span className="tag">{saved.generated ? v.panel.ready : v.panel.draft}</span>
            </div>
            <fieldset>
              <legend className="field-label">{v.panel.template}</legend>
              <div className="grid grid-cols-3 gap-2">
                {VIDEO_TEMPLATES.map((template) => {
                  const palette = PALETTES[template];
                  return (
                    <label key={template} className="cursor-pointer text-center">
                      <input type="radio" name="template" value={template} checked={draft.template === template} onChange={() => set('template', template)} className="peer sr-only" />
                      <span className="flex aspect-video items-center justify-center rounded-lg border-2 border-line peer-checked:border-blue peer-focus-visible:ring-3 peer-focus-visible:ring-blue/20" style={{ backgroundColor: palette.background, color: palette.title }}>
                        <Icon name="layers" />
                      </span>
                      <small className="mt-1 block text-[11px] text-muted">{v.panel.templates[template]}</small>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="video-accent" className="field-label">
                  {v.panel.accent}
                </label>
                <input id="video-accent" type="color" className="h-10 w-full cursor-pointer rounded-lg border border-line bg-white p-1" value={isAccent(draft.accent) ? draft.accent : '#127ee3'} onChange={(event) => set('accent', event.target.value)} />
              </div>
              <div>
                <label htmlFor="video-aspect" className="field-label">
                  {v.panel.aspect}
                </label>
                <select id="video-aspect" className="input" value={draft.aspect} onChange={(event) => set('aspect', event.target.value as VideoAspect)}>
                  {VIDEO_ASPECTS.map((aspect) => (
                    <option key={aspect} value={aspect}>
                      {v.panel.aspects[aspect]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {!saved.generated && <p className="hint mt-0">{v.panel.lockedHint}</p>}
            {shotBlock(0, (
              <>
                {textField('name', VIDEO_LIMITS.name)}
                {textField('position', VIDEO_LIMITS.position)}
              </>
            ))}
            {shotBlock(1, (
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <label htmlFor="video-sources" className="text-[12px] font-semibold">
                    {v.panel.sources}
                  </label>
                  <span className={`font-mono text-[10px] ${sourceLines > VIDEO_LIMITS.sources ? 'font-semibold text-red' : 'text-muted'}`}>{fill(v.panel.sourceCount, { n: sourceLines, max: VIDEO_LIMITS.sources })}</span>
                </div>
                <textarea id="video-sources" rows={4} className="input resize-y" value={draft.sources} disabled={!saved.generated} aria-invalid={sourceProblems.length > 0} aria-describedby={sourceProblems.length ? 'video-sources-error' : undefined} onChange={(event) => set('sources', event.target.value)} />
                {sourceProblems.length > 0 && (
                  <p id="video-sources-error" className="mt-1 text-[11px] text-red" role="alert">
                    {sourceProblems.map(messageOf).join(' · ')}
                  </p>
                )}
              </div>
            ))}
            {shotBlock(2, (
              <>
                {textField('question', VIDEO_LIMITS.question, true)}
                {textField('answer', VIDEO_LIMITS.answer, true)}
              </>
            ))}
            {shotBlock(3, textField('cta', VIDEO_LIMITS.cta))}
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={draft.music} onChange={(event) => set('music', event.target.checked)} className="size-4 accent-blue" />
              <Icon name="audio" className="size-4 text-muted" />
              {v.panel.music}
            </label>
            <button type="submit" className="btn w-full" disabled={busy !== null || !dirty || errors.length > 0}>
              {busy === 'save' ? <Spinner /> : <Icon name="check" />}
              {busy === 'save' ? v.panel.saving : v.panel.save}
            </button>
            {dirty && <p className="-mt-2 text-center text-[11px] text-orange">{v.panel.unsaved}</p>}
          </form>
        </aside>
      </div>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={v.generateTitle}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>
              {t.common.actions.cancel}
            </button>
            <button type="button" className="btn" onClick={() => void generate()}>
              <Icon name="sparkle" />
              {fill(saved.generated ? v.regenerate : v.generate, { n: VIDEO_SCRIPT_CREDITS })}
            </button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-[#3b4361]">{fill(saved.generated ? v.regenerateBody : v.generateBody, { n: VIDEO_SCRIPT_CREDITS })}</p>
      </Modal>
    </div>
  );
}
