'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DEFAULT_MODELS, MODEL_ID_MAX_LENGTH, MODEL_KINDS, MODEL_NAME_MAX_LENGTH, MODEL_TIMEOUT_MS, type ModelKind } from '@/lib/constants';
import type { GenerationAudience, ModelTransport } from '@/lib/domain/models';
import type { ModelConfigView } from '@/lib/services/models';
import type { ServicePricingInput } from '@/lib/domain/service-pricing';
import { ServiceCostFields } from '@/components/admin/service-cost-fields';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { CI } from '@/components/admin/console-icon';
import { ConfirmModal, Modal } from '@/components/admin/console-modal';
import { PageHead, Tag } from '@/components/admin/list-kit';
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
const AUDIENCES: GenerationAudience[] = ['free', 'plan'];

/** Prototype `jobHTML()`: from → to, status, progress, and what the state means for retrieval. */
function JobCard({ job }: { job: ReembedJobView }) {
  const { t, locale } = useI18n();
  const j = t.admin.models.job;
  const percent = job.total > 0 ? Math.min(100, Math.floor((job.done / job.total) * 100)) : job.status === 'done' ? 100 : 0;
  return (
    <section className="reembed-job card" aria-live="polite">
      <div className="between">
        <div className="flex">
          <span className={job.status === 'running' ? 'spinner' : 'blue'}>{job.status !== 'running' && <CI name={job.status === 'failed' ? 'info' : 'check'} />}</span>
          <div>
            <h3>{j.title}</h3>
            <p>
              {job.fromModelConfigId ? (job.fromName ?? j.unknown) : j.environment} → {job.toName ?? j.unknown}
            </p>
          </div>
        </div>
        <Tag tone={job.status === 'running' ? 'orange' : job.status === 'failed' ? 'red' : 'green'}>{j.status[job.status]}</Tag>
      </div>
      <div className="progress" role="progressbar" aria-label={j.title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="between">
        <span>{fill(j.progress, { done: formatNumber(Math.min(job.done, job.total), locale), total: formatNumber(job.total, locale) })}</span>
        <span>{percent}%</span>
      </div>
      <p>
        {job.status === 'running' ? j.running : job.status === 'failed' ? j.failed : j.done}
        {job.status === 'failed' && job.error && (
          <>
            <br />
            {fill(j.error, { error: job.error })}
          </>
        )}
        <br />
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
  inputUsdPerMillion: string;
  outputUsdPerMillion: string;
  costPricing: ServicePricingInput | null;
}

/**
 * `/admin/models` (2.5): a card per kind, any number of entries, one active
 * per generation audience (one per kind otherwise). Active entries cannot change model or endpoint; generation and
 * transcription switch on activation, embedding starts the full re-embed
 * job, whose progress is polled every two seconds while it runs; no other
 * embedding switch until it ends. Probes send a real request.
 */
export function ModelsBoard({ initial, initialJob }: { initial: Board; initialJob: ReembedJobView | null }) {
  const { t, locale } = useI18n();
  const m = t.admin.models;
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [probes, setProbes] = useState<Record<string, { busy: boolean; ok?: boolean; text?: string }>>({});
  const [activate, setActivate] = useState<{ config: ModelConfigView; audience: GenerationAudience } | null>(null);
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
            enabled: config.enabled || config.enabledPlan,
            tail: config.apiKeyTail,
            inputUsdPerMillion: config.generationPricing?.inputUsdPerMillion ?? '',
            outputUsdPerMillion: config.generationPricing?.outputUsdPerMillion ?? '',
            costPricing: config.costPricing,
          }
        : { id: null, name: kind === 'speech' ? 'OpenAI TTS-1' : '', kind, transport: 'gateway',
            baseUrl: '', model: kind === 'speech' ? DEFAULT_MODELS.speech : '',
            apiKey: '', timeout: 60, enabled: false, tail: null, inputUsdPerMillion: '', outputUsdPerMillion: '', costPricing: null },
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
      ...(draft.kind === 'generation' && draft.transport === 'openai_compatible' ? { generationPricing: { inputUsdPerMillion: draft.inputUsdPerMillion, outputUsdPerMillion: draft.outputUsdPerMillion } } : {}),
      ...(draft.kind === 'embedding' || draft.kind === 'transcription' ? { costPricing: draft.costPricing } : {}),
    };
    const result = draft.id
      ? await api<{ error?: string }>(`/api/admin/models/${draft.id}`, { method: 'PUT', json: payload })
      : await api<{ error?: string }>('/api/admin/models', { method: 'POST', json: payload });
    setSaving(false);
    if (!result.ok) {
      const code = result.data.error as keyof typeof m.errors | undefined;
      setError(result.data.error === 'cost_pricing' ? t.servicePricing.invalid : code && code in m.errors ? m.errors[code] : t.common.errors.generic);
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

  const doActivate = async (config: ModelConfigView, audience: GenerationAudience) => {
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
    const result = await api<{ activated: boolean; reembed: boolean; error?: string }>(`/api/admin/models/${config.id}/activate`, { method: 'POST', json: { audience } });
    if (!result.ok) return toast(result.data.error === 'voice_key_required' ? m.speechSetup : t.common.errors.generic);
    router.refresh();
  };

  const locked = Boolean(draft?.id && draft.enabled);

  const probeLine = (config: ModelConfigView) => {
    const result = probes[config.id];
    if (result?.text) return { ok: Boolean(result.ok), text: result.text };
    // The saved outcome of the last probe, so it survives a reload.
    if (config.lastProbeAt && config.lastProbeOk !== null)
      return { ok: config.lastProbeOk, text: fill(config.lastProbeOk ? m.lastProbeOk : m.lastProbeFailed, { time: formatDateTime(config.lastProbeAt, locale) }) };
    return null;
  };

  return (
    <>
      <PageHead
        title={m.title}
        lede={m.lede}
        actions={
          <div className="flex"><Link href="/admin/model-calls" className="btn secondary">{t.modelCalls.title}</Link><button type="button" className="btn" onClick={() => open('generation')}>
            <CI name="plus" />
            {m.add}
          </button></div>
        }
      />
      <div className="info-strip mb16">
        <CI name="info" />
        <span>{m.info}</span>
      </div>
      {job && <JobCard job={job} />}
      <div className="model-kind-grid">
        {MODEL_KINDS.map((kind) => {
          const configs = board.configs.filter((config) => config.kind === kind);
          const active = configs.find((config) => config.enabled);
          return (
            <section key={kind} className="card model-kind">
              <div className="model-kind-head">
                <span className="model-kind-icon">
                  <CI name={kind === 'generation' ? 'sparkle' : kind === 'embedding' ? 'layers' : 'audio'} />
                </span>
                <div>
                  <h2>{m.kinds[kind]}</h2>
                  <p>{m.kindNotes[kind]}</p>
                </div>
              </div>
              {kind === 'generation' && (
                <div className="model-audiences">
                  {AUDIENCES.map((audience) => {
                    const current = configs.find((config) => audience === 'plan' ? config.enabledPlan : config.enabled);
                    return (
                      <div key={audience} className="info-strip mb16">
                        <CI name={current ? 'check' : 'info'} />
                        <span><strong>{m.audiences[audience]}</strong> · {current ? `${current.name} · ${current.model}` : fill(m.fallbackBody, { model: board.fallbacks[kind].model })}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {kind !== 'generation' && !active && (
                <div className="info-strip mb16">
                  <CI name="info" />
                  <span>
                    {kind === 'speech' ? m.speechSetup : <><strong>{m.fallback}</strong> · {fill(m.fallbackBody, { model: board.fallbacks[kind].model })}</>}
                  </span>
                </div>
              )}
              {configs.map((config) => {
                const result = probes[config.id];
                const line = probeLine(config);
                const enabled = config.enabled || config.enabledPlan;
                return (
                  <article key={config.id} className={`model-config ${enabled ? 'enabled' : ''}`}>
                    <div className="between">
                      <strong>{config.name}</strong>
                      <Tag tone={enabled ? 'green' : 'grey'}>{kind === 'generation' && enabled ? AUDIENCES.filter((audience) => audience === 'plan' ? config.enabledPlan : config.enabled).map((audience) => m.audiences[audience]).join(' · ') : enabled ? m.enabled : m.inactive}</Tag>
                    </div>
                    <code>{config.model}</code>
                    <p>
                      {m.transports[config.transport]} · {Math.round(config.timeoutMs / 1000)}s
                    </p>
                    {config.baseUrl && <p className="model-endpoint">{config.baseUrl}</p>}
                    {kind === 'generation' && <p className="model-generation-pricing">
                      {config.transport === 'gateway' ? m.pricing.gateway : m.pricing.manual}
                      <br />{fill(m.pricing.summary, { input: config.generationPricing?.inputUsdPerMillion ?? '—', output: config.generationPricing?.outputUsdPerMillion ?? '—' })}
                    </p>}
                    {(kind === 'embedding' || kind === 'transcription') && <p className="service-cost-summary">
                      {t.servicePricing.title} · {config.costPricing ? fill(t.servicePricing.summary, { price: config.costPricing.price, unit: t.servicePricing.units[config.costPricing.unit] }) : config.transport === 'gateway' ? t.servicePricing.automatic : t.servicePricing.unknown}
                    </p>}
                    <div className="between model-key">
                      <span>
                        <CI name="lock" /> {config.hasKey ? `•••• ${config.apiKeyTail ?? ''}` : m.noKey}
                      </span>
                      <button type="button" className="icon-btn" aria-label={m.edit} title={m.edit} onClick={() => open(kind, config)}>
                        <CI name="settings" />
                      </button>
                    </div>
                    {line && <div className={`probe-result ${line.ok ? '' : 'error'}`}>{line.text}</div>}
                    <div className="flex model-config-actions">
                      <button type="button" className="btn secondary sm" onClick={() => probe(config)} disabled={result?.busy}>
                        {result?.busy ? m.probing : m.probe}
                      </button>
                      {kind === 'generation' ? AUDIENCES.map((audience) => (
                        (audience === 'plan' ? config.enabledPlan : config.enabled) ? (
                          <span key={audience} className="small muted"><CI name="check" /> {fill(m.inUseFor, { audience: m.audiences[audience] })}</span>
                        ) : (
                          <button key={audience} type="button" className="btn sm" onClick={() => setActivate({ config, audience })}>
                            {fill(m.activateFor, { audience: m.audiences[audience] })}
                          </button>
                        )
                      )) : config.enabled ? (
                        <span className="small muted">
                          <CI name="check" />
                          {m.inUse}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => setActivate({ config, audience: 'free' })}
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
              <button type="button" className="btn ghost full" onClick={() => open(kind)}>
                <CI name="plus" />
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
        subtitle={m.form.keyNote}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setDraft(null)}>
              {t.common.actions.cancel}
            </button>
            <button type="submit" form="model-form" className="btn" disabled={saving}>
              {m.form.save}
            </button>
          </>
        }
      >
        {draft && (
          <form
            id="model-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <div className="field">
              <label htmlFor="model-label">{m.form.name}</label>
              <input id="model-label" required maxLength={MODEL_NAME_MAX_LENGTH} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="model-kind">{m.form.kind}</label>
              <select id="model-kind" value={draft.kind} disabled={Boolean(draft.id)} onChange={(event) => {
                const kind = event.target.value as ModelKind;
                if (kind === 'speech' || draft.kind === 'speech') open(kind);
                else setDraft({ ...draft, kind, costPricing: null });
              }}>
                {MODEL_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {m.kinds[kind]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="model-transport">{m.form.transport}</label>
              <select id="model-transport" value={draft.transport} disabled={locked || draft.kind === 'speech'} onChange={(event) => setDraft({ ...draft, transport: event.target.value as ModelTransport, inputUsdPerMillion: '', outputUsdPerMillion: '' })}>
                <option value="gateway">{m.transports.gateway}</option>
                <option value="openai_compatible">{m.transports.openai_compatible}</option>
              </select>
            </div>
            {draft.transport === 'openai_compatible' && (
              <div className="field">
                <label htmlFor="model-base">{m.form.baseUrl}</label>
                <input id="model-base" type="url" required placeholder="https://api.example.com/v1" value={draft.baseUrl} disabled={locked || draft.kind === 'speech'} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
              </div>
            )}
            <div className="field">
              <label htmlFor="model-name">{m.form.model}</label>
              <input id="model-name" required maxLength={MODEL_ID_MAX_LENGTH} placeholder="provider/model" value={draft.model} disabled={locked} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
              <small>{draft.transport === 'gateway' ? m.form.modelHintGateway : m.form.modelHintCompatible}</small>
            </div>
            {draft.kind === 'generation' && (draft.transport === 'gateway' ? (
              <div className="info-strip"><CI name="info" /><span>{m.pricing.gatewayNote}</span></div>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="model-input-price">{m.pricing.input}</label>
                  <input id="model-input-price" type="number" min="0" max="99999999.999999" step="0.000001" value={draft.inputUsdPerMillion} onChange={(event) => setDraft({ ...draft, inputUsdPerMillion: event.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="model-output-price">{m.pricing.output}</label>
                  <input id="model-output-price" type="number" min="0" max="99999999.999999" step="0.000001" value={draft.outputUsdPerMillion} onChange={(event) => setDraft({ ...draft, outputUsdPerMillion: event.target.value })} />
                  <small>{m.pricing.manualNote}</small>
                </div>
              </>
            ))}
            {(draft.kind === 'embedding' || draft.kind === 'transcription') && <>
              <ServiceCostFields service={draft.kind} value={draft.costPricing} onChange={(costPricing) => setDraft({ ...draft, costPricing })} note={t.servicePricing.modelNote} />
              <p className="small muted">{draft.transport === 'gateway' ? t.servicePricing.gatewayNote : t.servicePricing.unknownNote}</p>
            </>}
            <div className="field">
              <label htmlFor="model-key">{m.form.apiKey}</label>
              <input
                id="model-key"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                placeholder={draft.tail ? fill(m.form.apiKeyKeep, { tail: draft.tail }) : m.form.apiKeyCarry}
                onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
              />
              <small>{m.form.apiKeyHint}</small>
            </div>
            <div className="field">
              <label htmlFor="model-timeout">{m.form.timeout}</label>
              <input
                id="model-timeout"
                type="number"
                required
                step={1}
                min={MODEL_TIMEOUT_MS.min / 1000}
                max={MODEL_TIMEOUT_MS.max / 1000}
                value={draft.timeout}
                onChange={(event) => setDraft({ ...draft, timeout: Number(event.target.value) })}
              />
            </div>
            <div className="info-strip">
              <CI name="info" />
              <span>{locked ? m.form.lockedNote : m.form.rules}</span>
            </div>
          </form>
        )}
      </Modal>

      <ConfirmModal
        open={Boolean(activate)}
        title={activate?.config.kind === 'embedding' ? m.reembedTitle : activate?.config.kind === 'generation' ? fill(m.activateAudienceTitle, { name: activate.config.name, audience: m.audiences[activate.audience] }) : fill(m.activateTitle, { name: activate?.config.name ?? '' })}
        body={activate?.config.kind === 'embedding' ? fill(m.job.confirmBody, { name: activate.config.name }) : activate?.config.kind === 'generation' ? fill(m.activateAudienceBody, { audience: m.audiences[activate.audience] }) : m.activateBody}
        confirmLabel={activate?.config.kind === 'embedding' ? m.reembed : m.activate}
        onClose={() => setActivate(null)}
        onConfirm={() => activate && doActivate(activate.config, activate.audience)}
      />
    </>
  );
}
