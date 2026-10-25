'use client';

import { useActionState, useRef, useState, useTransition } from 'react';

import { FIELD, Field } from '@/components/admin/form-fields';
import { submitOn } from '@/components/admin/platform-library-shared';
import { ConsoleButton, Pill } from '@/components/admin/ui';
import type {
  RenderConfigActionResult,
  RenderProbeActionResult,
} from '@/app/admin/(console)/models/actions';
import { fill } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/client';
import {
  RENDER_KEYS_MAX,
  RENDER_PROVIDERS,
  type RenderKeyFailure,
  type RenderProviderName,
} from '@/lib/domain/render-config';

/** A stored key as the page may know it: no key, no mask. Dates as ISO strings. */
export interface RenderKeyEntry {
  id: string;
  label: string;
  enabled: boolean;
  failure: RenderKeyFailure | null;
  failedAt: string | null;
  coolingDown: boolean;
}

export interface RenderConfigEntry {
  provider: RenderProviderName;
  baseUrl: string | null;
  enabled: boolean;
}

type Action = (
  previous: RenderConfigActionResult | null,
  form: FormData,
) => Promise<RenderConfigActionResult>;

/**
 * The rendering fallback: which service, where, and each service's key pool.
 *
 * Two forms because they change at different rates and mean different things.
 * The provider is an append-only configuration (switching vendor is a decision
 * with a history); the pool is a list an operator tops up when keys run dry.
 * Keys are never sent to the browser -- a stored key is a label, a position
 * and what the vendor last said about it.
 */
export function RenderConfigForm({
  current,
  keys,
  saveConfig,
  saveKeys,
  probe,
}: {
  /** The saved configuration, or null where nothing was saved yet. */
  current: RenderConfigEntry | null;
  keys: Record<RenderProviderName, RenderKeyEntry[]>;
  saveConfig: Action;
  saveKeys: Action;
  probe: (form: FormData) => Promise<RenderProbeActionResult>;
}) {
  const [provider, setProvider] = useState<RenderProviderName>(current?.provider ?? 'firecrawl');
  return (
    <div className="flex flex-col">
      <ConfigForm current={current} provider={provider} onProvider={setProvider} action={saveConfig} probe={probe} />
      {/* Keyed by provider and by the pool as stored, so a switch or a save
          (or a probe that marked a key) replaces the local order, the typed
          keys and the action state with what the server now holds. */}
      <KeysForm
        key={`${provider}:${keys[provider]
          .map((key) => `${key.id}.${key.label}.${key.enabled}.${key.failure}`)
          .join('|')}`}
        provider={provider}
        keys={keys[provider]}
        selfHosted={current !== null && current.provider === provider && current.baseUrl !== null}
        action={saveKeys}
      />
    </div>
  );
}

function ConfigForm({
  current,
  provider,
  onProvider,
  action,
  probe,
}: {
  current: RenderConfigEntry | null;
  provider: RenderProviderName;
  onProvider: (provider: RenderProviderName) => void;
  action: Action;
  probe: (form: FormData) => Promise<RenderProbeActionResult>;
}) {
  const { t } = useI18n();
  const r = t.admin.render;
  const [state, formAction, pending] = useActionState(action, null);

  /* The probe reads the form the save would post but is not its action. */
  const formRef = useRef<HTMLFormElement>(null);
  const [probing, startProbe] = useTransition();
  const [probed, setProbed] = useState<RenderProbeActionResult | null>(null);
  function runProbe() {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    startProbe(async () => setProbed(await probe(data)));
  }

  return (
    <form ref={formRef} onSubmit={submitOn(formAction)} className="flex flex-col gap-4 px-[19px] py-4">
      <div className="flex flex-wrap gap-2">
        {RENDER_PROVIDERS.map((option) => {
          const active = option === provider;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onProvider(option)}
              aria-current={active ? 'true' : undefined}
              className={`flex items-center gap-2 rounded-[9px] border-2 px-3 py-2 text-left transition-colors ${
                active ? 'border-brand bg-brandsoft' : 'border-line bg-card hover:bg-subtle'
              }`}
            >
              <span className="text-[12px] font-semibold tracking-[-0.023em] text-ink">
                {r.providers[option]}
              </span>
              {current?.provider === option ? (
                <Pill tone={current.enabled ? 'ok' : 'neutral'}>
                  {current.enabled ? r.stateOn : r.stateOff}
                </Pill>
              ) : null}
            </button>
          );
        })}
      </div>
      <input type="hidden" name="provider" value={provider} />
      <p className="text-[12px] tracking-[-0.023em] text-muted">{r.providerNote[provider]}</p>

      <Field label={r.baseUrl}>
        <input
          name="baseUrl"
          /* Keyed by provider: a self-hosted Firecrawl address is not a
             self-hosted AnySearch address. */
          key={provider}
          defaultValue={current?.provider === provider ? (current.baseUrl ?? '') : ''}
          placeholder={r.baseUrlPlaceholder}
          spellCheck={false}
          className={`${FIELD} font-mono`}
        />
      </Field>
      <p className="-mt-2 text-[11px] tracking-[-0.023em] text-faint">{r.baseUrlHint}</p>

      <label className="flex items-center gap-2 text-[12px] tracking-[-0.023em] text-steel">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={current?.enabled ?? true}
          className="size-4 accent-brand"
        />
        {r.enabled}
      </label>
      <Field label={r.reason}>
        <input name="reason" className={FIELD} required />
      </Field>
      {state && !state.ok ? (
        <p className="text-[12px] tracking-[-0.023em] text-danger">{r.errors[state.error ?? 'unavailable']}</p>
      ) : null}
      {state?.ok ? <p className="text-[12px] tracking-[-0.023em] text-steel">{r.saved}</p> : null}
      {probed ? <ProbeOutcome result={probed} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <ConsoleButton type="submit" variant="primary" disabled={pending || probing}>
          {r.save}
        </ConsoleButton>
        <ConsoleButton type="button" onClick={runProbe} disabled={pending || probing}>
          {probing ? r.probing : r.probe}
        </ConsoleButton>
        <span className="text-[11px] text-faint">{r.probeHint}</span>
      </div>
    </form>
  );
}

function ProbeOutcome({ result }: { result: RenderProbeActionResult }) {
  const { t, locale } = useI18n();
  const r = t.admin.render;
  if (result.kind === 'refused') {
    return <p className="text-[12px] tracking-[-0.023em] text-danger">{r.errors[result.error]}</p>;
  }
  const seconds = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(result.latencyMs / 1000);
  if (!result.ok) {
    return (
      <p className="text-[12px] tracking-[-0.023em] text-danger">
        {r.probeFailed} · {seconds} s · {result.error}
      </p>
    );
  }
  return (
    <p className="text-[12px] tracking-[-0.023em] text-steel">
      <span className="font-semibold text-good">{r.probeOk}</span> · {seconds} s ·{' '}
      <span className="font-mono text-ink">{result.detail}</span>
    </p>
  );
}

interface Row extends RenderKeyEntry {
  removed: boolean;
}

function KeysForm({
  provider,
  keys,
  selfHosted,
  action,
}: {
  provider: RenderProviderName;
  keys: RenderKeyEntry[];
  /** The configuration in force calls this provider self-hosted, without keys. */
  selfHosted: boolean;
  action: Action;
}) {
  const { t, locale } = useI18n();
  const r = t.admin.render;
  const [state, formAction, pending] = useActionState(action, null);
  const [rows, setRows] = useState<Row[]>(() => keys.map((key) => ({ ...key, removed: false })));
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  function move(index: number, by: -1 | 1) {
    setRows((current) => {
      const next = [...current];
      const target = index + by;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }
  function toggleRemoved(id: string) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, removed: !row.removed } : row)));
  }

  return (
    <form onSubmit={submitOn(formAction)} className="flex flex-col gap-4 border-t-2 border-line px-[19px] py-4">
      <input type="hidden" name="provider" value={provider} />
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-semibold tracking-[-0.023em] text-ink">
          {fill(r.keysFor, { provider: r.providers[provider] })}
        </span>
        <p className="text-[12px] tracking-[-0.023em] text-muted">{r.keysDescription}</p>
        {selfHosted ? <p className="text-[12px] tracking-[-0.023em] text-warn">{r.keysSelfHostedNote}</p> : null}
      </div>

      {rows.length === 0 ? (
        <p className="text-[12px] tracking-[-0.023em] text-muted">{r.keysEmpty}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-line rounded-[9px] border-2 border-line">
          {rows.map((row, index) => (
            <li
              key={row.id}
              className={`flex flex-wrap items-center gap-3 px-3 py-2.5 ${row.removed ? 'bg-subtle opacity-60' : ''}`}
            >
              {/* Only kept rows are posted, in the order shown. */}
              {row.removed ? null : <input type="hidden" name="keep" value={row.id} />}
              <span className="w-5 font-mono text-[11px] text-faint">{index + 1}</span>
              <input
                name={`label:${row.id}`}
                defaultValue={row.label}
                aria-label={r.keyLabel}
                disabled={row.removed}
                className={`${FIELD} w-40 sm:w-48`}
              />
              <span className="flex flex-wrap items-center gap-1.5">
                {row.removed ? (
                  <Pill tone="danger">{r.keyRemoved}</Pill>
                ) : row.failure ? (
                  <>
                    <Pill tone={row.failure === 'exhausted' ? 'warn' : 'danger'}>
                      {row.failedAt
                        ? fill(r.keyFailedAt, {
                            failure: r.keyFailure[row.failure],
                            date: date.format(new Date(row.failedAt)),
                          })
                        : r.keyFailure[row.failure]}
                    </Pill>
                    {row.coolingDown ? <Pill tone="neutral">{r.keyCooling}</Pill> : null}
                  </>
                ) : (
                  <Pill tone="ok">{r.keyHealthy}</Pill>
                )}
              </span>
              <span className="ml-auto flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-[12px] tracking-[-0.023em] text-steel">
                  <input
                    type="checkbox"
                    name={`enabled:${row.id}`}
                    defaultChecked={row.enabled}
                    disabled={row.removed}
                    className="size-4 accent-brand"
                  />
                  {r.keyEnabled}
                </label>
                {row.failure && !row.removed ? (
                  <label className="flex items-center gap-1.5 text-[12px] tracking-[-0.023em] text-steel">
                    <input type="checkbox" name={`clear:${row.id}`} className="size-4 accent-brand" />
                    {r.keyClear}
                  </label>
                ) : null}
                <ConsoleButton size="sm" variant="ghost" onClick={() => move(index, -1)} disabled={index === 0}>
                  {r.keyUp}
                </ConsoleButton>
                <ConsoleButton
                  size="sm"
                  variant="ghost"
                  onClick={() => move(index, 1)}
                  disabled={index === rows.length - 1}
                >
                  {r.keyDown}
                </ConsoleButton>
                <ConsoleButton size="sm" onClick={() => toggleRemoved(row.id)}>
                  {row.removed ? r.keyRestore : r.keyRemove}
                </ConsoleButton>
              </span>
            </li>
          ))}
        </ol>
      )}

      <Field label={r.addKeys} hint={`${r.addKeysHint} ≤ ${RENDER_KEYS_MAX}`}>
        <textarea
          name="add"
          rows={3}
          autoComplete="off"
          spellCheck={false}
          className={`${FIELD} h-auto py-2 font-mono`}
        />
      </Field>
      <Field label={r.reason}>
        <input name="reason" className={FIELD} required />
      </Field>
      {state && !state.ok ? (
        <p className="text-[12px] tracking-[-0.023em] text-danger">{r.errors[state.error ?? 'unavailable']}</p>
      ) : null}
      {state?.ok ? <p className="text-[12px] tracking-[-0.023em] text-steel">{r.keysSaved}</p> : null}
      <div>
        <ConsoleButton type="submit" variant="primary" disabled={pending}>
          {r.saveKeys}
        </ConsoleButton>
      </div>
    </form>
  );
}
