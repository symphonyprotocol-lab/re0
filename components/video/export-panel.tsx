'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { put } from '@vercel/blob/client';
import { VIDEO_EXPORT_CREDITS } from '@/lib/constants';
import { exportBrowserRefused, exportCost, introSize, scriptDownload, type IntroProps } from '@/lib/domain/video';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDate } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

export interface LastExport {
  url: string;
  aspect: string;
  cost: number;
  finishedAt: string | null;
  /** Whether it shows what is saved now. */
  current: boolean;
}

type Start =
  | { cached: true; url: string; aspect: string }
  | { cached: false; exportId: string; cost: number; props: IntroProps; upload: { pathname: string; token: string } };

type Job =
  | { phase: 'render' | 'upload'; percent: number }
  | { phase: 'finish' };

/** `free-license` qualifies only individuals and companies of up to three people (2.6); a remotion.pro public key replaces it. */
const LICENSE_KEY = process.env.NEXT_PUBLIC_REMOTION_LICENSE_KEY || 'free-license';

/**
 * Export & share (prototype suite.js `exportVideo`, 2.6 "导出 MP4"): the
 * owner's browser renders the saved introduction with `renderMediaOnWeb()`
 * -- the same composition the Player shows, from the props the server
 * returns -- and uploads the MP4 straight to Blob. Before anything is held,
 * `canRenderMediaOnWeb()` probes the browser (Safari and phones are told to
 * use desktop Chrome or Edge). Cancelling, or leaving the page, releases
 * the hold; the cron is the backstop for a closed tab.
 */
export function ExportPanel({
  ree,
  props,
  dirty,
  exportsCount,
  lastExport,
  onExported,
}: {
  ree: { id: string; name: string; slug: string; isPublic: boolean };
  props: IntroProps | null;
  dirty: boolean;
  exportsCount: number;
  lastExport: LastExport | null;
  onExported: (count: number) => void;
}) {
  const { t, locale } = useI18n();
  const e = t.video.export;
  const toast = useToast();
  const router = useRouter();
  const [dialog, setDialog] = useState<'unsupported' | 'confirm' | null>(null);
  const [quote, setQuote] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<{ url: string; aspect: string; cost: number; cached: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<{ exportId: string; controller: AbortController } | null>(null);
  const cost = exportCost(exportsCount);

  /* Leaving the page mid-export gives the hold back now rather than at the next cron run. */
  useEffect(() => {
    const leave = () => {
      const current = running.current;
      if (!current) return;
      current.controller.abort();
      void fetch(`/api/rees/${ree.id}/video/exports/${current.exportId}`, { method: 'DELETE', keepalive: true });
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [ree.id]);

  const probe = async () => {
    setError(null);
    if (!props) return;
    if (exportBrowserRefused(navigator.userAgent)) {
      setDialog('unsupported');
      return;
    }
    try {
      const { canRenderMediaOnWeb } = await import('@remotion/web-renderer');
      const check = await canRenderMediaOnWeb({ ...introSize(props.aspect), container: 'mp4', videoCodec: 'h264', muted: !props.music });
      if (!check.canRender) {
        setDialog('unsupported');
        return;
      }
    } catch {
      setDialog('unsupported');
      return;
    }
    /* The same picture exported before is handed over at once: free, uncounted, nothing to confirm. */
    const quoted = await api<{ cached?: string | null; cost?: number; error?: string }>(`/api/rees/${ree.id}/video/exports`);
    if (!quoted.ok) {
      setError(quoted.data.error === 'no_script' ? e.noScript : fill(e.failed, { reason: quoted.data.error ?? quoted.status }));
      return;
    }
    if (quoted.data.cached) {
      setResult({ url: quoted.data.cached, aspect: props.aspect, cost: 0, cached: true });
      toast(e.cached);
      return;
    }
    setQuote(quoted.data.cost ?? cost);
    setDialog('confirm');
  };

  const run = async () => {
    setDialog(null);
    setResult(null);
    setError(null);
    setJob({ phase: 'render', percent: 0 });
    const started = await api<Start & { error?: string }>(`/api/rees/${ree.id}/video/exports`, { method: 'POST' });
    if (!started.ok) {
      setJob(null);
      setError(started.data.error === 'insufficient_credits' ? e.insufficient : started.data.error === 'no_script' ? e.noScript : fill(e.failed, { reason: started.data.error ?? started.status }));
      return;
    }
    const start = started.data;
    if (start.cached) {
      setJob(null);
      setResult({ url: start.url, aspect: start.aspect, cost: 0, cached: true });
      toast(e.cached);
      return;
    }
    const controller = new AbortController();
    running.current = { exportId: start.exportId, controller };
    try {
      const [{ renderMediaOnWeb }, { introComposition }] = await Promise.all([import('@remotion/web-renderer'), import('@/video/intro')]);
      const { getBlob } = await renderMediaOnWeb({
        composition: { ...introComposition(start.props.aspect), defaultProps: start.props },
        inputProps: start.props,
        container: 'mp4',
        videoCodec: 'h264',
        muted: !start.props.music,
        licenseKey: LICENSE_KEY,
        signal: controller.signal,
        onProgress: ({ progress }) => setJob({ phase: 'render', percent: Math.round(progress * 100) }),
      });
      const blob = await getBlob();
      setJob({ phase: 'upload', percent: 0 });
      await put(start.upload.pathname, blob, {
        access: 'private',
        token: start.upload.token,
        contentType: 'video/mp4',
        multipart: blob.size > 8 * 1024 * 1024,
        abortSignal: controller.signal,
        onUploadProgress: (event) => setJob({ phase: 'upload', percent: Math.round(event.percentage) }),
      });
      setJob({ phase: 'finish' });
      const done = await api<{ url?: string; cost?: number; error?: string }>(`/api/rees/${ree.id}/video/exports/${start.exportId}/complete`, { method: 'POST' });
      if (!done.ok || !done.data.url) throw new Error(done.data.error ?? 'complete');
      running.current = null;
      setResult({ url: done.data.url, aspect: start.props.aspect, cost: done.data.cost ?? start.cost, cached: false });
      onExported(exportsCount + 1);
      router.refresh();
    } catch (failure) {
      running.current = null;
      await api(`/api/rees/${ree.id}/video/exports/${start.exportId}`, { method: 'DELETE' });
      if (controller.signal.aborted) toast(e.cancelled);
      else setError(fill(e.failed, { reason: failure instanceof Error ? failure.message : 'render' }));
      router.refresh();
    } finally {
      setJob(null);
    }
  };

  const cancel = () => running.current?.controller.abort();

  const share = async () => {
    await navigator.clipboard.writeText(`${window.location.origin}/r/${ree.slug}?video=1`).catch(() => undefined);
    toast(e.shareCopied);
  };

  const downloadScript = () => {
    if (!props) return;
    const file = new Blob([JSON.stringify(scriptDownload(ree.name, props), null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(file);
    link.download = `re0-${ree.slug}-script.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const shown = result ?? (lastExport ? { url: lastExport.url, aspect: lastExport.aspect, cost: lastExport.cost, cached: false } : null);
  return (
    <section className="card p-5" aria-labelledby="video-export-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="video-export-title" className="text-[15px] font-bold">
            {e.title}
          </h2>
          <p className="mt-1 text-[12px] text-muted">{exportsCount === 0 ? e.firstFree : fill(e.later, { n: VIDEO_EXPORT_CREDITS })}</p>
          {props && <p className="mt-1 font-mono text-[11px] text-muted">{fill(e.spec, { aspect: props.aspect })}</p>}
        </div>
        <span className="tag border-[#cfe0f7] bg-soft text-blue">{cost === 0 ? e.freeTag : fill(e.costTag, { n: cost })}</span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn" disabled={!props || dirty || job !== null} onClick={() => void probe()} title={dirty ? e.saveFirst : undefined}>
          <Icon name="download" />
          {e.button}
        </button>
        <button type="button" className="btn-secondary" disabled={!ree.isPublic || !props} onClick={() => void share()}>
          <Icon name="copy" />
          {e.share}
        </button>
        <button type="button" className="btn-ghost" disabled={!props} onClick={downloadScript}>
          <Icon name="code" />
          {e.script}
        </button>
      </div>
      {dirty && props && <p className="hint">{e.saveFirst}</p>}
      {!ree.isPublic && <p className="hint">{e.sharePrivate}</p>}

      {job && (
        <div className="mt-4 rounded-lg border border-line bg-wash p-3" role="status">
          <div className="flex items-center justify-between gap-2 text-[12px] font-semibold">
            <span className="flex items-center gap-2">
              <Spinner className="size-3.5" />
              {job.phase === 'finish' ? e.finishing : fill(job.phase === 'render' ? e.rendering : e.uploading, { n: job.percent })}
            </span>
            {job.phase !== 'finish' && (
              <button type="button" className="btn-ghost" onClick={cancel}>
                {e.cancel}
              </button>
            )}
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
            <span className="block h-full bg-blue transition-[width]" style={{ width: `${job.phase === 'finish' ? 100 : job.percent}%` }} />
          </div>
          <small className="mt-2 block text-[11px] text-muted">{e.keepOpen}</small>
        </div>
      )}
      {error && (
        <p className="mt-4 rounded-lg border border-[#f1d4d4] bg-[#fff6f6] px-3 py-2 text-[12px] text-red" role="alert">
          {error}
        </p>
      )}
      {!job && shown && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#cfe9de] bg-[#f1faf6] px-3 py-2.5 text-[12px]">
          <span className="flex items-center gap-2 text-green">
            <Icon name="check" />
            {result
              ? result.cached
                ? e.cached
                : fill(e.done, { aspect: result.aspect, cost: result.cost })
              : fill(e.lastExport, { aspect: shown.aspect, date: lastExport?.finishedAt ? formatDate(lastExport.finishedAt, locale) : '' })}
          </span>
          <span className="flex gap-2">
            <a href={`${shown.url}?download=1`} className="btn-secondary btn-sm" download>
              <Icon name="download" />
              {e.download}
            </a>
            <a href={shown.url} target="_blank" rel="noreferrer" className="btn-ghost">
              <Icon name="external" />
              {e.open}
            </a>
          </span>
          {!result && lastExport && !lastExport.current && <span className="w-full text-[11px] text-muted">{e.outdated}</span>}
        </div>
      )}

      <Modal
        open={dialog === 'unsupported'}
        onClose={() => setDialog(null)}
        title={e.unsupportedTitle}
        footer={
          <button type="button" className="btn" onClick={() => setDialog(null)}>
            {e.gotIt}
          </button>
        }
      >
        <p className="text-[13px] leading-relaxed text-[#3b4361]">{e.unsupportedBody}</p>
      </Modal>
      <Modal
        open={dialog === 'confirm'}
        onClose={() => setDialog(null)}
        title={e.confirmTitle}
        subtitle={props ? fill(e.spec, { aspect: props.aspect }) : undefined}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setDialog(null)}>
              {t.common.actions.cancel}
            </button>
            <button type="button" className="btn" onClick={() => void run()}>
              {e.start}
            </button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-[#3b4361]">{(quote ?? cost) === 0 ? e.confirmFree : fill(e.confirmPaid, { n: quote ?? cost })}</p>
        <p className="mt-2 text-[12px] text-muted">{e.confirmKeep}</p>
      </Modal>
    </section>
  );
}
