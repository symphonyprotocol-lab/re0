'use client';

import dynamic from 'next/dynamic';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { VIDEO_ASPECTS, VIDEO_TEMPLATES, type VideoAspect, type VideoTemplate } from '@/lib/constants';
import { isAccent, type IntroProps, type VideoScenes } from '@/lib/domain/video';
import { narrationPath, storyTemplate } from '@/lib/domain/product-demo';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { PlaceholderPoster, type CoverRee } from '@/components/video/video-cover';
import { PIcon, type PIconName } from '@/components/rees/proto-icon';
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
}

function draftOf(video: SavedVideo): Draft {
  return { template: video.template, accent: video.accentColor, aspect: video.aspect, music: video.music };
}

const TEMPLATE_ICONS: Record<VideoTemplate, PIconName> = {
  'product-demo': 'audio',
  'user-manual': 'book',
  'course-intro': 'users',
  'article-summary': 'text',
};

/*
 * Rough client-side pacing for the progress steps (seconds since the request
 * started). The server sends no progress, so the last step stays active
 * until the response arrives.
 */
const GENERATION_STEPS = [['script', 0], ['voice', 8], ['compose', 20]] as const;

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * `/rees/[id]/video` (prototype suite.js `videoEditor`): pick the video type
 * (product demo, user manual, course introduction or article summary; the
 * type that suits the Ree's knowledge is suggested), generate its narrated
 * script at the current price (only with a ready source), pick the accent
 * and music, preview it in the Player with the beat timeline, then export,
 * share or download the script. Switching to another type needs a new
 * script before it can be previewed or saved.
 */
export function VideoStudio({
  ree,
  readySources,
  recommended,
  scriptCredits,
  exportCredits,
  demoCredits,
  initial,
  initialProps,
  lastExport,
}: {
  ree: CoverRee & { id: string; slug: string; isPublic: boolean };
  readySources: number;
  recommended: VideoTemplate;
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

  const story = saved.scenes?.demo;
  /* The chosen type has no script of its own yet: generate before it can be previewed or saved. */
  const needsStory = !story || storyTemplate(story) !== draft.template;
  const kindName = v.panel.templates[draft.template];
  const dirty = JSON.stringify(draftOf(saved)) !== JSON.stringify(draft);
  const previewProps: IntroProps | null = savedProps && story && !needsStory
    ? {
        ...savedProps, template: draft.template, accent: isAccent(draft.accent) ? draft.accent.toLowerCase() : savedProps.accent,
        aspect: draft.aspect, music: draft.music, narrationUrl: `/media/${narrationPath(ree.id, story.audioId)}`,
      }
    : null;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const generate = async () => {
    if (demoCredits === null) return;
    setConfirming(false);
    setBusy('generate');
    setNotice(null);
    const response = await api<{ video?: SavedVideo; props?: IntroProps | null; cost?: number; error?: string }>(
      `/api/rees/${ree.id}/video/script`, { method: 'POST', json: { template: draft.template, revision: saved.revision, maxCost: demoCredits } },
    ).catch(() => null);
    setBusy(null);
    if (!response?.ok || !response.data.video) {
      const code = response?.data.error;
      setNotice(code === 'voice_not_configured' ? v.demo.voiceMissing : code === 'price_changed' ? v.demo.priceChanged : code === 'stale' ? v.panel.stale
        : code === 'insufficient_credits' ? v.export.insufficient : code === 'no_ready_source' ? v.needsSource : code === 'script_running' ? v.scriptRunning
        : code === 'demo_script_unfit' ? v.demo.scriptUnfit
        : !response ? v.demo.networkError : v.demo.failed);
      router.refresh();
      return;
    }
    const video = response.data.video;
    setSaved(video);
    setSavedProps(response.data.props ?? null);
    /* A new script replaces the story; an accent or music change not yet saved stays in the form. */
    setDraft((current) => ({ ...draftOf(video), accent: current.accent, music: current.music }));
    toast(response.data.cost !== undefined ? fill(v.demo.generated, { n: response.data.cost }) : v.demo.done);
    router.refresh();
  };

  const save = async () => {
    if (!isAccent(draft.accent)) {
      setNotice(v.panel.invalidAccent);
      return;
    }
    setBusy('save');
    setNotice(null);
    const response = await api<{ video?: SavedVideo; props?: IntroProps | null; error?: string }>(`/api/rees/${ree.id}/video`, {
      method: 'PATCH',
      json: { revision: saved.revision, template: draft.template, accent: draft.accent.toLowerCase(), aspect: draft.aspect, music: draft.music },
    }).catch(() => ({ ok: false, status: 0, data: { error: 'network' } as { video?: SavedVideo; props?: IntroProps | null; error?: string } }));
    setBusy(null);
    if (!response.ok || !response.data.video) {
      const code = response.data.error;
      setNotice(code === 'stale' ? v.panel.stale : code === 'no_script' ? v.demo.switchHint : fill(v.panel.saveFailed, { reason: code ?? response.status }));
      return;
    }
    setSaved(response.data.video);
    setSavedProps(response.data.props ?? null);
    setDraft(draftOf(response.data.video));
    toast(v.panel.saved);
  };

  const generateLabel = demoCredits === null ? v.demo.unavailable : fill(v.demo.generate, { n: demoCredits });
  const activeStep = GENERATION_STEPS.reduce((active, [, from], index) => (elapsed >= from ? index : active), 0);
  const progress = generating && (
    <div className="video-generation-overlay">
      <div className="video-generation-skeleton" aria-hidden="true"><i /><i /><i /></div>
      <div className="video-generation-card" role="status">
        <p>
          <strong>{fill(v.demo.generating, { kind: kindName })}</strong>
          <span className="mono" aria-hidden="true">{clock(elapsed)}</span>
        </p>
        <ol className="video-generation-steps">
          {GENERATION_STEPS.map(([step], index) => (
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

  return (
    <main className="page video-editor-page">
      <div className="page-head">
        <div>
          <p className="eyebrow section-kicker">YOUR KNOWLEDGE, CONNECTED</p>
          <h1>{v.heading}</h1>
          <p>{fill(v.demo.lede, { name: ree.name, kind: kindName })}</p>
        </div>
        <button type="button" className="btn secondary" disabled={readySources === 0 || busy !== null || demoCredits === null} aria-busy={generating || undefined} onClick={() => setConfirming(true)}>
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
      {demoCredits === null && <p className="form-hint video-needs-source">{v.demo.voiceMissing}</p>}
      {notice && (
        <p className="form-error" role="alert">
          {notice}
        </p>
      )}

      <div className="video-editor-grid">
        <section className="video-preview-column">
          <div className="video-preview-stage" aria-busy={generating || undefined}>
            {previewProps ? (
              <IntroPlayer key={`${previewProps.template}/${previewProps.aspect}/${story?.audioId ?? ''}`} props={previewProps} name={ree.name} timeline />
            ) : (
              <div className="card video-player-card">
                <PlaceholderPoster ree={ree} />
              </div>
            )}
            {progress}
          </div>
          {!previewProps && <p className="form-hint">{saved.generated ? v.demo.switchHint : v.demo.hint}</p>}
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
              <span className="tag">{saved.generated && !needsStory ? v.panel.ready : v.panel.draft}</span>
            </div>
            <label className="field-label">{v.panel.template}</label>
            <div className="video-templates">
              {VIDEO_TEMPLATES.map((template) => (
                <label key={template}>
                  <input type="radio" name="template" value={template} checked={draft.template === template} disabled={busy !== null}
                    onChange={() => set('template', template)} />
                  <span className={`template-swatch template-${template}`}>
                    <PIcon name={TEMPLATE_ICONS[template]} />
                  </span>
                  {template === recommended && <span className="template-recommended">{v.panel.recommended}</span>}
                  <small>{v.panel.templates[template]}</small>
                </label>
              ))}
            </div>
            <div className="form-hint video-template-focus">
              {v.kinds[draft.template].focus}
              <ol>
                {v.kinds[draft.template].beats.map((beat) => <li key={beat}>{beat}</li>)}
              </ol>
            </div>
            <div className="two-col">
              <div className="field">
                <label htmlFor="video-accent">{v.panel.accent}</label>
                <input type="color" id="video-accent" name="accent" value={isAccent(draft.accent) ? draft.accent : '#127ee3'} disabled={generating} onChange={(event) => set('accent', event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="video-aspect">{v.panel.aspect}</label>
                <select name="aspect" id="video-aspect" value={draft.aspect} disabled onChange={(event) => set('aspect', event.target.value as VideoAspect)}>
                  {VIDEO_ASPECTS.map((aspect) => (
                    <option key={aspect} value={aspect}>
                      {v.panel.aspects[aspect]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              {story && !needsStory && story.kind === undefined && story.visual && (
                <p className="form-hint">{fill(v.demo.visual, { layout: v.demo.layouts[story.visual.layout], subject: story.visual.subject })}</p>
              )}
              <label>{v.demo.voiceLabel}</label>
              {story && !needsStory ? <ol className="video-demo-script">{story.cues.map((cue) => <li key={cue.start}>{cue.text}</li>)}</ol>
                : <p className="form-hint">{v.demo.hint}</p>}
            </div>
            <label className="video-music">
              <input type="checkbox" name="music" checked={draft.music} disabled={generating} onChange={(event) => set('music', event.target.checked)} />
              <PIcon name="audio" />
              {v.demo.music}
            </label>
            <button className="btn full" type="submit" disabled={busy !== null || !dirty || (needsStory && saved.generated)}>
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
        title={fill(v.demo.confirm, { kind: kindName })}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>
              {t.common.actions.cancel}
            </button>
            <button type="button" className="btn" disabled={demoCredits === null} onClick={() => void generate()}>
              <Icon name="sparkle" />
              {generateLabel}
            </button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-[#3b4361]">{demoCredits === null ? v.demo.voiceMissing
          : fill(v.demo.body, { n: demoCredits, script: scriptCredits, kind: kindName })}</p>
        {saved.generated && <p className="form-hint">{v.demo.replace}</p>}
      </Modal>
    </main>
  );
}
