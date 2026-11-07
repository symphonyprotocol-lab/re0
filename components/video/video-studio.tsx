'use client';

import dynamic from 'next/dynamic';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { VIDEO_ASPECTS, VIDEO_LIMITS, VIDEO_SHOT_SECONDS, VIDEO_TEMPLATES, type VideoAspect, type VideoTemplate } from '@/lib/constants';
import { chars, DEFAULT_STYLE, isAccent, sceneErrors, type IntroProps, type SceneError, type SceneField, type VideoScenes } from '@/lib/domain/video';
import { narrationPath, PRODUCT_DEMO_TEMPLATE } from '@/lib/domain/product-demo';
import { api } from '@/lib/client/upload';
import { PALETTES } from '@/video/theme';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { PlaceholderPoster, type CoverRee } from '@/components/video/video-cover';
import { PIcon } from '@/components/rees/proto-icon';
import '@/components/rees/ree-pages.css';
import './video-pages.css';
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

/*
 * Rough client-side pacing for the progress steps (seconds since the request
 * started). The server sends no progress, so the last step stays active
 * until the response arrives.
 */
const GENERATION_STEPS = {
  demo: [['script', 0], ['voice', 8], ['compose', 20]],
  classic: [['script', 0], ['compose', 12]],
} as const;

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * `/rees/[id]/video` (prototype suite.js `videoEditor`): generate the
 * four-shot script at the current price (only with a ready source), edit each shot
 * within its limit -- an over-limit edit shows its error at once and cannot
 * be saved -- pick a template, accent, aspect and music, preview it in the
 * Player with the shot timeline, then export, share or download the script.
 * The preview follows the unsaved edits; the export uses what is saved.
 */
export function VideoStudio({
  ree,
  readySources,
  scriptCredits,
  exportCredits,
  demoCredits,
  initial,
  initialProps,
  lastExport,
}: {
  ree: CoverRee & { id: string; slug: string; isPublic: boolean };
  readySources: number;
  scriptCredits: number;
  exportCredits: number;
  demoCredits: number | null;
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
  const [templateChosen, setTemplateChosen] = useState(false);
  const [busy, setBusy] = useState<'generate' | 'save' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const generating = busy === 'generate';

  useEffect(() => {
    if (!generating) return;
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [generating]);

  const isDemo = draft.template === PRODUCT_DEMO_TEMPLATE;
  const generationTemplate = templateChosen ? draft.template : DEFAULT_STYLE.template;
  const generateDemo = generationTemplate === PRODUCT_DEMO_TEMPLATE;
  const generationLimit = generateDemo ? demoCredits : scriptCredits;
  const demo = saved.scenes?.demo;
  const needsDemo = isDemo && !demo;
  const scenes = useMemo(() => scenesOf(draft), [draft]);
  const errors = saved.generated && !isDemo ? sceneErrors(scenes) : [];
  const dirty = JSON.stringify(draftOf(saved)) !== JSON.stringify(draft);
  const previewProps: IntroProps | null = savedProps && !needsDemo
    ? {
        ...savedProps, template: draft.template, accent: isAccent(draft.accent) ? draft.accent.toLowerCase() : savedProps.accent,
        aspect: draft.aspect, music: draft.music, scenes: isDemo && demo ? { ...scenes, demo } : errors.length ? scenesOf(draftOf(saved)) : scenes,
        narrationUrl: isDemo && demo ? `/media/${narrationPath(ree.id, demo.audioId)}` : undefined,
      }
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
    if (generationLimit === null) return;
    setConfirming(false);
    setBusy('generate');
    setNotice(null);
    const response = await api<{ video?: SavedVideo; props?: IntroProps | null; cost?: number; error?: string }>(
      `/api/rees/${ree.id}/video/script`, { method: 'POST', json: { template: generationTemplate, revision: saved.revision, maxCost: generationLimit } },
    ).catch(() => null);
    setBusy(null);
    if (!response?.ok || !response.data.video) {
      const code = response?.data.error;
      setNotice(code === 'voice_not_configured' ? v.demo.voiceMissing : code === 'price_changed' ? v.demo.priceChanged : code === 'stale' ? v.panel.stale
        : code === 'insufficient_credits' ? v.export.insufficient : code === 'no_ready_source' ? v.needsSource : code === 'script_running' ? v.scriptRunning
        : code === 'demo_script_unfit' ? v.demo.scriptUnfit
        : !response ? v.demo.networkError : generateDemo ? v.demo.failed : v.scriptFailed);
      router.refresh();
      return;
    }
    const video = response.data.video;
    setSaved(video);
    setSavedProps(response.data.props ?? null);
    /* A new script replaces the shots; style edits not yet saved stay in the form. */
    setDraft((current) => ({
      ...draftOf(video),
      accent: current.accent,
      aspect: generateDemo ? video.aspect : current.aspect,
      music: current.template === video.template ? current.music : video.music,
    }));
    toast(generateDemo && response.data.cost !== undefined ? fill(v.demo.generated, { n: response.data.cost }) : v.generated);
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
      json: { revision: saved.revision, template: draft.template, accent: draft.accent.toLowerCase(), aspect: draft.aspect, music: draft.music, ...(saved.generated && !isDemo ? { scenes } : {}) },
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

  const labels = v.panel.labels;
  const problemsOf = (field: SceneField) => {
    const problems = errorFor(field);
    return problems.length > 0 ? (
      <small id={`video-${field}-error`} className="video-field-error" role="alert">
        {problems.map(messageOf).join(' · ')}
      </small>
    ) : null;
  };
  const textField = (key: 'name' | 'position' | 'question' | 'answer' | 'cta', max: number, multiline = false) => {
    const problems = errorFor(key);
    const id = `scene-${key}`;
    const shared = {
      id,
      name: key,
      value: draft[key],
      disabled: !saved.generated || generating,
      'aria-invalid': problems.length > 0,
      'aria-describedby': problems.length ? `video-${key}-error` : undefined,
    };
    return (
      <div className="field">
        <label htmlFor={id}>{fill(labels[key], { max })}</label>
        {multiline ? (
          <textarea {...shared} rows={key === 'answer' ? 3 : 2} onChange={(event) => set(key, event.target.value)} />
        ) : (
          <input {...shared} onChange={(event) => set(key, event.target.value)} />
        )}
        {problemsOf(key)}
      </div>
    );
  };
  const sourceProblems = errorFor('sources');
  const generateLabel = generationLimit === null ? v.demo.unavailable
    : fill(generateDemo ? v.demo.generate : saved.generated ? v.regenerate : v.generate, { n: generationLimit });

  const steps = GENERATION_STEPS[generateDemo ? 'demo' : 'classic'];
  const activeStep = steps.reduce((active, [, from], index) => (elapsed >= from ? index : active), 0);
  const progress = generating && (
    <div className="video-generation-overlay">
      <div className="video-generation-skeleton" aria-hidden="true"><i /><i /><i /></div>
      <div className="video-generation-card" role="status">
        <p>
          <strong>{generateDemo ? v.demo.generating : v.generating}</strong>
          <span className="mono" aria-hidden="true">{clock(elapsed)}</span>
        </p>
        <ol className="video-generation-steps">
          {steps.map(([step], index) => (
            <li key={step} data-state={index < activeStep ? 'done' : index === activeStep ? 'active' : 'pending'} aria-current={index === activeStep ? 'step' : undefined}>
              {index < activeStep ? <PIcon name="check" /> : <i aria-hidden="true" />}
              {v.progress.steps[step]}
            </li>
          ))}
        </ol>
        <small>{previewProps ? v.progress.replacing : v.progress.first}</small>
      </div>
    </div>
  );

  const shotBlock = (index: number, children: React.ReactNode) => (
    <details className="scene-editor" open={index === 0}>
      <summary>
        <span className="mono">0{index + 1}</span>
        {v.shots[index]}
        <small>{fill(v.shotLength, { n: VIDEO_SHOT_SECONDS[index]! })}</small>
        <PIcon name="down" />
      </summary>
      {children}
    </details>
  );

  return (
    <main className="page video-editor-page">
      <div className="page-head">
        <div>
          <p className="eyebrow section-kicker">YOUR KNOWLEDGE, CONNECTED</p>
          <h1>{v.heading}</h1>
          <p>{fill(isDemo ? v.demo.lede : v.lede, { name: ree.name })}</p>
        </div>
        <button type="button" className="btn secondary" disabled={readySources === 0 || busy !== null || generationLimit === null} aria-busy={generating || undefined} onClick={() => setConfirming(true)}>
          {generating ? <PIcon name="refresh" className="video-generate-spin" /> : <PIcon name="sparkle" />}
          {generating ? fill(v.progress.elapsed, { time: clock(elapsed) }) : generateLabel}
        </button>
      </div>
      {/* Not in the prototype, which generates from any Ree: a script needs a ready source (8.2). */}
      {readySources === 0 && (
        <p className="form-hint video-needs-source">
          {v.needsSource}{' '}
          <Link href={`/rees/${ree.id}/knowledge`} className="text-link">
            {v.addKnowledge}
          </Link>
        </p>
      )}
      {generateDemo && demoCredits === null && <p className="form-hint video-needs-source">{v.demo.voiceMissing}</p>}
      {notice && (
        <p className="form-error" role="alert">
          {notice}
        </p>
      )}

      <div className="video-editor-grid">
        <section className="video-preview-column">
          <div className="video-preview-stage" aria-busy={generating || undefined}>
            {previewProps ? (
              <IntroPlayer key={`${previewProps.template}/${previewProps.aspect}/${demo?.audioId ?? ''}`} props={previewProps} name={ree.name} timeline />
            ) : (
              <div className="card video-player-card">
                <PlaceholderPoster ree={ree} />
              </div>
            )}
            {progress}
          </div>
          {!previewProps && <p className="form-hint">{needsDemo ? v.demo.hint : v.placeholderHint}</p>}
          <ExportPanel ree={ree} props={savedProps} dirty={dirty} exportsCount={saved.exportsCount} exportCredits={exportCredits} lastExport={lastExport} onExported={(count) => setSaved((current) => ({ ...current, exportsCount: count }))} />
        </section>

        <aside className="card video-edit-panel" aria-label={v.panel.title} aria-busy={generating || undefined}>
          <form
            id="video-edit-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            noValidate
          >
            <div className="video-edit-header">
              <h2>{v.panel.title}</h2>
              <span className="tag">{saved.generated && !needsDemo ? v.panel.ready : v.panel.draft}</span>
            </div>
            <label className="field-label">{v.panel.template}</label>
            <div className="video-templates">
              {VIDEO_TEMPLATES.map((template) => (
                <label key={template}>
                  <input type="radio" name="template" value={template} checked={draft.template === template} disabled={busy !== null}
                    onClick={() => setTemplateChosen(true)}
                    onChange={() => {
                      setTemplateChosen(true);
                      setDraft((current) => ({ ...current, template,
                        ...(template === PRODUCT_DEMO_TEMPLATE ? { aspect: '16:9' as const, music: demo ? current.music : true } : {}),
                      }));
                    }} />
                  <span className={`template-swatch template-${template}`}>
                    <PIcon name={template === PRODUCT_DEMO_TEMPLATE ? 'audio' : 'layers'} />
                  </span>
                  <small>{v.panel.templates[template]}</small>
                </label>
              ))}
            </div>
            {generateDemo && !isDemo && <p className="form-hint">{v.demo.defaultHint}</p>}
            <div className="two-col">
              <div className="field">
                <label htmlFor="video-accent">{v.panel.accent}</label>
                <input type="color" id="video-accent" name="accent" value={isAccent(draft.accent) ? draft.accent : '#127ee3'} disabled={generating} onChange={(event) => set('accent', event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="video-aspect">{v.panel.aspect}</label>
                <select name="aspect" id="video-aspect" value={draft.aspect} disabled={isDemo || generating} onChange={(event) => set('aspect', event.target.value as VideoAspect)}>
                  {VIDEO_ASPECTS.map((aspect) => (
                    <option key={aspect} value={aspect}>
                      {v.panel.aspects[aspect]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {isDemo ? (
              <div className="field">
                {demo?.visual && <p className="form-hint">{fill(v.demo.visual, { layout: v.demo.layouts[demo.visual.layout], subject: demo.visual.subject })}</p>}
                <label>{v.demo.voiceLabel}</label>
                {demo ? <ol className="video-demo-script">{demo.cues.map((cue) => <li key={cue.start}>{cue.text}</li>)}</ol>
                  : <p className="form-hint">{v.demo.hint}</p>}
              </div>
            ) : <>
            {!saved.generated && <p className="form-hint video-locked-hint">{v.panel.lockedHint}</p>}
            {shotBlock(0, (
              <>
                {textField('name', VIDEO_LIMITS.name)}
                {textField('position', VIDEO_LIMITS.position)}
              </>
            ))}
            {shotBlock(1, (
              <div className="field">
                <label htmlFor="scene-sources">{fill(labels.sources, { n: VIDEO_LIMITS.sources, max: VIDEO_LIMITS.source })}</label>
                <textarea
                  name="sources"
                  id="scene-sources"
                  rows={4}
                  value={draft.sources}
                  disabled={!saved.generated || generating}
                  aria-invalid={sourceProblems.length > 0}
                  aria-describedby={sourceProblems.length ? 'video-sources-error' : undefined}
                  onChange={(event) => set('sources', event.target.value)}
                />
                {problemsOf('sources')}
              </div>
            ))}
            {shotBlock(2, (
              <>
                {textField('question', VIDEO_LIMITS.question, true)}
                {textField('answer', VIDEO_LIMITS.answer, true)}
              </>
            ))}
            {shotBlock(3, textField('cta', VIDEO_LIMITS.cta))}
            </>}
            <label className="video-music">
              <input type="checkbox" name="music" checked={draft.music} disabled={generating} onChange={(event) => set('music', event.target.checked)} />
              <PIcon name="audio" />
              {isDemo ? v.demo.music : v.panel.music}
            </label>
            <button className="btn full" type="submit" disabled={busy !== null || !dirty || (needsDemo && saved.generated) || errors.length > 0}>
              <PIcon name="check" />
              {busy === 'save' ? v.panel.saving : v.panel.save}
            </button>
            {dirty && <p className="form-hint video-unsaved">{v.panel.unsaved}</p>}
          </form>
        </aside>
      </div>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={generateDemo ? v.demo.confirm : v.generateTitle}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>
              {t.common.actions.cancel}
            </button>
            <button type="button" className="btn" disabled={generationLimit === null} onClick={() => void generate()}>
              <Icon name="sparkle" />
              {generateLabel}
            </button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-[#3b4361]">{generationLimit === null ? v.demo.voiceMissing
          : fill(generateDemo ? v.demo.body : saved.generated ? v.regenerateBody : v.generateBody, { n: generationLimit, script: scriptCredits })}</p>
        {generateDemo && saved.generated && <p className="form-hint">{v.demo.replace}</p>}
      </Modal>
    </main>
  );
}
