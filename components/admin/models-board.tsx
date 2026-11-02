'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { MODEL_KINDS, type ModelKind } from '@/lib/constants';
import type { ModelTransport } from '@/lib/domain/models';
import type { ModelConfigView } from '@/lib/services/models';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

interface Board {
  configs: ModelConfigView[];
  fallbacks: Record<ModelKind, { model: string; transport: string }>;
}

/** The latest re-embed job as the page and `GET /api/admin/models/reembed` answer it (dates as strings). */
export interface ReembedJobView {
  id: string;
  status: 'running' | 'done' | 'failed';
  total: number;
  done: number;
  error: string | null;
  fromName: string | null;
  fromModelConfigId: string | null;
  toName: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const JOB_POLL_MS = 2_000;

/** Prototype `jobHTML()`: from → to, status, progress, and what the state means for retrieval. */
function JobCard({ job }: { job: ReembedJobView }) {
  const { t, locale } = useI18n();
  const j = t.admin.models.job;
  const percent = job.total > 0 ? Math.min(100, Math.floor((job.done / job.total) * 100)) : job.status === 'done' ? 100 : 0;
  const tone = job.status === 'running' ? 'border-[#cfe1fb] bg-soft text-blue' : job.status === 'failed' ? 'border-[#f1d4d4] bg-[#fff3f3] text-red' : 'border-[#cde8df] bg-[#effaf6] text-green';
  return (
    <section className="card mt-5 p-5" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className={`inline-flex size-9 flex-none items-center justify-center rounded-lg border ${tone}`}>
            {job.status === 'running' ? <Spinner /> : <Icon name={job.status === 'failed' ? 'info' : 'check'} />}
          </span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold">{j.title}</h2>
            <p className="mt-0.5 text-[12px] break-words text-muted">
              {job.fromModelConfigId ? (job.fromName ?? j.unknown) : j.environment} → {job.toName ?? j.unknown}
            </p>
          </div>
        </div>
        <span className={`tag flex-none ${tone}`}>{j.status[job.status]}</span>
      </div>
      <div
        className="mt-4 h-2 overflow-hidden rounded-full bg-wash"
        role="progressbar"
        aria-label={j.title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span className={`block h-full rounded-full transition-[width] ${job.status === 'failed' ? 'bg-red' : job.status === 'done' ? 'bg-green' : 'bg-blue'}`} style={{ width: `${percent}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-muted">
        <span>{fill(j.progress, { done: formatNumber(job.done, locale), total: formatNumber(job.total, locale) })}</span>
        <span>{percent}%</span>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-[#3b4361]">{job.status === 'running' ? j.running : job.status === 'failed' ? j.failed : j.done}</p>
      {job.status === 'failed' && job.error && <p className="mt-1 text-[12px] break-words text-red">{fill(j.error, { error: job.error })}</p>}
      <p className="mt-2 text-[11px] text-muted">
        {fill(j.started, { time: formatDateTime(job.startedAt, locale) })}
        {job.finishedAt && <> · {fill(j.finished, { time: formatDateTime(job.finishedAt, locale) })}</>}
      </p>
    </section>
  );
}

interface Draft {
  id: string | null;
  name: string;
  kind: ModelKind;
  transport: ModelTransport;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeout: number;
  enabled: boolean;
  tail: string | null;
}

/**
 * `/admin/models` (2.5): a card per kind, any number of entries, exactly one
 * active. Active entries cannot change model or endpoint; generation and
 * transcription switch on activation, embedding starts the full re-embed
 * job, whose progress is polled every two seconds while it runs; no other
 * embedding switch until it ends. Probes send a real request.
 */
export function ModelsBoard({ initial, initialJob }: { initial: Board; initialJob: ReembedJobView | null }) {
  const { t } = useI18n();
  const m = t.admin.models;
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [probes, setProbes] = useState<Record<string, { busy: boolean; ok?: boolean; text?: string }>>({});
  const [activate, setActivate] = useState<ModelConfigView | null>(null);
  const [job, setJob] = useState<ReembedJobView | null>(initialJob);
  const board = initial;
  const running = job?.status === 'running';

  /* A refresh brings the server's view of the job. */
  useEffect(() => setJob(initialJob), [initialJob]);

  /* While the job runs, poll its progress (the poll also keeps a stalled job moving); refresh once it ends. */
  const jobId = running ? job.id : null;
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      const result = await api<{ job: ReembedJobView | null }>('/api/admin/models/reembed', { cache: 'no-store' }).catch(() => null);
      if (stopped || !result?.ok) return;
      const next = result.data.job;
      setJob(next);
      if (!next || next.id !== jobId || next.status !== 'running') {
        stopped = true;
        window.clearInterval(timer);
        router.refresh();
      }
    }, JOB_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [jobId, router]);

  const open = (kind: ModelKind, config?: ModelConfigView) => {
    setError('');
    setDraft(
      config
        ? {
            id: config.id,
            name: config.name,
            kind: config.kind,
            transport: config.transport,
            baseUrl: config.baseUrl ?? '',
            model: config.model,
            apiKey: '',
            timeout: Math.round(config.timeoutMs / 1000),
            enabled: config.enabled,
            tail: config.apiKeyTail,
          }
        : { id: null, name: '', kind, transport: 'gateway', baseUrl: '', model: '', apiKey: '', timeout: 60, enabled: false, tail: null },
    );
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    const payload = {
      name: draft.name,
      kind: draft.kind,
      transport: draft.transport,
      baseUrl: draft.transport === 'openai_compatible' ? draft.baseUrl : null,
      model: draft.model,
      apiKey: draft.apiKey,
      timeoutMs: Math.round(draft.timeout * 1000),
    };
    const result = draft.id
      ? await api<{ error?: string }>(`/api/admin/models/${draft.id}`, { method: 'PUT', json: payload })
      : await api<{ error?: string }>('/api/admin/models', { method: 'POST', json: payload });
    setSaving(false);
    if (!result.ok) {
      const code = result.data.error as keyof typeof m.errors | undefined;
      setError(code && code in m.errors ? m.errors[code] : t.common.errors.generic);
      return;
    }
    setDraft(null);
    router.refresh();
  };

  const probe = async (config: ModelConfigView) => {
    setProbes((current) => ({ ...current, [config.id]: { busy: true } }));
    const result = await api<{ ok: boolean; latencyMs: number; detail: string }>(`/api/admin/models/${config.id}/probe`, { method: 'POST' });
    setProbes((current) => ({
      ...current,
      [config.id]: {
        busy: false,
        ok: result.ok && result.data.ok,
        text: result.ok && result.data.ok ? fill(m.probeOk, { ms: result.data.latencyMs }) : fill(m.probeFailed, { detail: result.data.detail ?? String(result.status) }),
      },
    }));
    router.refresh();
  };

  const doActivate = async (config: ModelConfigView) => {
    setActivate(null);
    if (config.kind === 'embedding') {
      /* The re-embed endpoint creates the job and starts it after answering; with nothing indexed it simply enables the entry. */
      const result = await api<{ error?: string; activated?: boolean; reembed?: boolean; job?: ReembedJobView | null }>('/api/admin/models/reembed', {
        method: 'POST',
        json: { to: config.id },
      });
      if (!result.ok) {
        const code = result.data.error as keyof typeof m.errors | undefined;
        toast(code && code in m.errors ? m.errors[code] : t.common.errors.generic);
        router.refresh();
        return;
      }
      if (result.data.reembed && result.data.job) {
        setJob(result.data.job);
        toast(m.job.startedToast);
      } else if (result.data.activated) toast(m.job.activated);
      router.refresh();
      return;
    }
    const result = await api<{ activated: boolean; reembed: boolean }>(`/api/admin/models/${config.id}/activate`, { method: 'POST' });
    if (!result.ok) return toast(t.common.errors.generic);
    router.refresh();
  };

  const locked = Boolean(draft?.id && draft.enabled);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-extrabold tracking-tight">{m.title}</h1>
          <p className="mt-2 text-[13px] text-muted">{m.lede}</p>
        </div>
        <button type="button" className="btn" onClick={() => open('generation')}>
          <Icon name="plus" />
          {m.add}
        </button>
      </div>
      <p className="mt-5 flex gap-2 rounded-lg bg-soft px-3 py-2.5 text-[12px] text-[#3b4361]">
        <Icon name="info" className="mt-0.5 size-4 flex-none text-blue" />
        {m.info}
      </p>
      {job && <JobCard job={job} />}
      <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
        {MODEL_KINDS.map((kind) => {
          const configs = board.configs.filter((config) => config.kind === kind);
          const active = configs.find((config) => config.enabled);
          return (
            <section key={kind} className="card flex flex-col gap-3 p-5">
              <h2 className="text-[15px] font-bold">{m.kinds[kind]}</h2>
              {!active && (
                <div className="rounded-lg border border-dashed border-line bg-wash px-3 py-2.5 text-[11px] text-muted">
                  <strong className="block text-ink">{m.fallback}</strong>
                  {fill(m.fallbackBody, { model: board.fallbacks[kind].model })}
                </div>
              )}
              {configs.map((config) => {
                const result = probes[config.id];
                return (
                  <article key={config.id} className={`rounded-xl border p-4 ${config.enabled ? 'border-blue bg-soft/40' : 'border-line'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <strong className="min-w-0 truncate text-[13px]">{config.name}</strong>
                      <span className={`tag flex-none ${config.enabled ? 'border-[#cfe9de] bg-[#f1faf6] text-green' : ''}`}>{config.enabled ? m.enabled : m.inactive}</span>
                    </div>
                    <code className="mt-2 block truncate font-mono text-[12px]">{config.model}</code>
                    <p className="mt-1 text-[11px] text-muted">
                      {m.transports[config.transport]} · {Math.round(config.timeoutMs / 1000)}s
                    </p>
                    {config.baseUrl && <p className="truncate text-[11px] text-muted">{config.baseUrl}</p>}
                    <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted">
                      <span className="flex items-center gap-1">
                        <Icon name="lock" className="size-3" />
                        {config.hasKey ? `•••• ${config.apiKeyTail ?? ''}` : m.noKey}
                      </span>
                      <button type="button" className="icon-btn" aria-label={m.edit} title={m.edit} onClick={() => open(kind, config)}>
                        <Icon name="settings" className="size-3.5" />
                      </button>
                    </div>
                    {result?.text && <p className={`mt-2 rounded-md px-2 py-1.5 text-[11px] break-words ${result.ok ? 'bg-[#f1faf6] text-green' : 'bg-[#fff3f3] text-red'}`}>{result.text}</p>}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button type="button" className="btn-secondary btn-sm" onClick={() => probe(config)} disabled={result?.busy}>
                        {result?.busy && <Spinner className="size-3" />}
                        {result?.busy ? m.probing : m.probe}
                      </button>
                      {config.enabled ? (
                        <span className="flex items-center gap-1 text-[11px] text-muted">
                          <Icon name="check" className="size-3.5" />
                          {m.inUse}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setActivate(config)}
                          disabled={kind === 'embedding' && running}
                          title={kind === 'embedding' && running ? m.job.blocked : undefined}
                        >
                          {kind === 'embedding' ? m.reembed : m.activate}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
              <button type="button" className="btn-ghost mt-auto w-full" onClick={() => open(kind)}>
                <Icon name="plus" className="size-3.5" />
                {m.addFor}
              </button>
            </section>
          );
        })}
      </div>

      <Modal
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        title={draft?.id ? m.form.editTitle : m.form.createTitle}
        subtitle={locked ? m.form.lockedNote : m.form.newNote}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setDraft(null)}>
              {t.common.actions.cancel}
            </button>
            <button type="button" className="btn" onClick={save} disabled={saving}>
              {saving && <Spinner />}
              {m.form.save}
            </button>
          </>
        }
      >
        {draft && (
          <div className="flex flex-col gap-4">
            <label>
              <span className="field-label">{m.form.name}</span>
              <input className="input" maxLength={60} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label>
              <span className="field-label">{m.form.kind}</span>
              <select className="input" value={draft.kind} disabled={Boolean(draft.id)} onChange={(event) => setDraft({ ...draft, kind: event.target.value as ModelKind })}>
                {MODEL_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {m.kinds[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">{m.form.transport}</span>
              <select className="input" value={draft.transport} disabled={locked} onChange={(event) => setDraft({ ...draft, transport: event.target.value as ModelTransport })}>
                <option value="gateway">{m.transports.gateway}</option>
                <option value="openai_compatible">{m.transports.openai_compatible}</option>
              </select>
            </label>
            {draft.transport === 'openai_compatible' && (
              <label>
                <span className="field-label">{m.form.baseUrl}</span>
                <input className="input font-mono" placeholder="https://api.example.com/v1" value={draft.baseUrl} disabled={locked} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
              </label>
            )}
            <label>
              <span className="field-label">{m.form.model}</span>
              <input className="input font-mono" value={draft.model} disabled={locked} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
              <small className="hint">{draft.transport === 'gateway' ? m.form.modelHintGateway : m.form.modelHintCompatible}</small>
            </label>
            <label>
              <span className="field-label">{m.form.apiKey}</span>
              <input
                className="input font-mono"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                placeholder={draft.tail ? fill(m.form.apiKeyKeep, { tail: draft.tail }) : m.form.apiKeyCarry}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
              <small className="hint">{m.form.apiKeyHint}</small>
            </label>
            <label>
              <span className="field-label">{m.form.timeout}</span>
              <input className="input max-w-[160px] font-mono" type="number" min={1} max={300} value={draft.timeout} onChange={(event) => setDraft({ ...draft, timeout: Number(event.target.value) })} />
            </label>
            {error && (
              <p role="alert" className="text-[12px] text-red">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={Boolean(activate)}
        title={activate?.kind === 'embedding' ? m.reembedTitle : fill(m.activateTitle, { name: activate?.name ?? '' })}
        body={activate?.kind === 'embedding' ? fill(m.job.confirmBody, { name: activate.name }) : m.activateBody}
        confirmLabel={activate?.kind === 'embedding' ? m.reembed : m.activate}
        onClose={() => setActivate(null)}
        onConfirm={() => activate && doActivate(activate)}
      />
    </div>
  );
}
