'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { MODEL_KINDS, type ModelKind } from '@/lib/constants';
import type { ModelTransport } from '@/lib/domain/models';
import type { ModelConfigView } from '@/lib/services/models';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { ConfirmModal, Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

interface Board {
  configs: ModelConfigView[];
  fallbacks: Record<ModelKind, { model: string; transport: string }>;
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
 * transcription switch on activation, embedding opens the re-embed job
 * (a placeholder until step 5). Probes send a real request.
 */
export function ModelsBoard({ initial }: { initial: Board }) {
  const { t } = useI18n();
  const m = t.admin.models;
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [probes, setProbes] = useState<Record<string, { busy: boolean; ok?: boolean; text?: string }>>({});
  const [activate, setActivate] = useState<ModelConfigView | null>(null);
  const [reembed, setReembed] = useState<ModelConfigView | null>(null);
  const board = initial;

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
    const result = await api<{ activated: boolean; reembed: boolean }>(`/api/admin/models/${config.id}/activate`, { method: 'POST' });
    if (!result.ok) return toast(t.common.errors.generic);
    if (result.data.reembed) setReembed(config);
    router.refresh();
  };

  const locked = Boolean(draft?.id && draft.enabled);

  return (
    <main className="mx-auto max-w-[1240px] px-4 py-8 md:px-8">
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
                        <button type="button" className="btn btn-sm" onClick={() => setActivate(config)}>
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
        title={fill(m.activateTitle, { name: activate?.name ?? '' })}
        body={activate?.kind === 'embedding' ? m.reembedTitle : m.activateBody}
        confirmLabel={activate?.kind === 'embedding' ? m.reembed : m.activate}
        onClose={() => setActivate(null)}
        onConfirm={() => activate && doActivate(activate)}
      />
      <Modal open={Boolean(reembed)} onClose={() => setReembed(null)} title={m.reembedTitle} footer={<button type="button" className="btn" onClick={() => setReembed(null)}>{t.common.actions.confirm}</button>}>
        <p className="text-[13px] leading-relaxed text-muted">{fill(m.reembedBody, { name: reembed?.name ?? '' })}</p>
      </Modal>
    </main>
  );
}
