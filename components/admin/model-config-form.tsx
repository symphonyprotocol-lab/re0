'use client';

import { useActionState, useRef, useState, useTransition } from 'react';

import { Bounded, FIELD, Field, range } from '@/components/admin/form-fields';
import { submitOn } from '@/components/admin/platform-asset-shared';
import { ConsoleButton, Pill } from '@/components/admin/ui';
import type {
  ModelConfigActionResult,
  ModelProbeActionResult,
} from '@/app/admin/(console)/models/actions';
import { useI18n } from '@/lib/i18n/client';
import {
  EMBEDDING_DIMENSIONS,
  MODEL_KINDS,
  timeoutBoundsFor,
  type ModelKind,
} from '@/lib/domain/model-config';

export interface ProviderModelEntry {
  kind: ModelKind;
  label: string;
  baseUrl: string;
  model: string;
  hasCredential: boolean;
  dimensions: number | null;
  timeoutMs: number;
  enabled: boolean;
}

/** What a kind that was never configured starts from, so the form is never empty. */
const BLANK: Record<ModelKind, ProviderModelEntry> = {
  embedding: {
    kind: 'embedding',
    label: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    hasCredential: false,
    dimensions: EMBEDDING_DIMENSIONS.default,
    timeoutMs: timeoutBoundsFor('embedding').default,
    enabled: true,
  },
  rerank: {
    kind: 'rerank',
    label: '',
    baseUrl: 'https://api.cohere.com/v2',
    model: 'rerank-v3.5',
    hasCredential: false,
    dimensions: null,
    timeoutMs: timeoutBoundsFor('rerank').default,
    enabled: true,
  },
};

/**
 * The two retrieval models. One entry per kind, and every save mints an
 * immutable successor (manage-model-config.ts), so adding a model, editing one
 * and switching one off are the same append.
 *
 * The credential field is always empty on load and blank means "keep the
 * stored one": a page that pre-filled it would have to send a provider secret
 * to the browser to do it, and re-typing a key to change a timeout is how keys
 * end up somewhere they can be copied from.
 */
export function ModelConfigForm({
  entries,
  usable,
  fromEnvironment,
  action,
  probe,
}: {
  entries: Record<ModelKind, ProviderModelEntry | null>;
  /** Whether each stage can run -- the key opened, not merely stored. */
  usable: Record<ModelKind, boolean>;
  /** Kinds with no saved entry that run on the deployment's variables. */
  fromEnvironment: Record<ModelKind, boolean>;
  action: (
    previous: ModelConfigActionResult | null,
    form: FormData,
  ) => Promise<ModelConfigActionResult>;
  /** One call against the endpoint as typed, saved or not. */
  probe: (form: FormData) => Promise<ModelProbeActionResult>;
}) {
  const { t } = useI18n();
  const p = t.admin.models;
  const [kind, setKind] = useState<ModelKind>('embedding');

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap gap-2 px-[19px] pt-4">
        {MODEL_KINDS.map((option) => {
          const entry = entries[option];
          const active = option === kind;
          const subtitle = entry
            ? entry.model
            : fromEnvironment[option]
              ? p.kindEnvironment
              : p.kindUnset;
          return (
            <button
              key={option}
              type="button"
              onClick={() => setKind(option)}
              aria-current={active ? 'true' : undefined}
              className={`flex items-center gap-2 rounded-[9px] border-2 px-3 py-2 text-left transition-colors ${
                active ? 'border-brand bg-brandsoft' : 'border-line bg-card hover:bg-subtle'
              }`}
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-[12px] font-semibold tracking-[-0.023em] text-ink">
                  {p.kinds[option]}
                </span>
                <span className="font-mono text-[10.5px] text-faint">{subtitle}</span>
              </span>
              {entry || fromEnvironment[option] ? (
                <Pill tone={usable[option] ? 'ok' : 'neutral'}>
                  {usable[option] ? p.stateOn : p.stateOff}
                </Pill>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Keyed by kind so switching replaces the uncontrolled inputs *and* the
          action state: a "saved" or an error belongs to the kind it was
          submitted for, not to whichever tab is showing now. */}
      <KindForm
        key={kind}
        kind={kind}
        entry={entries[kind]}
        fromEnvironment={fromEnvironment[kind]}
        action={action}
        probe={probe}
      />
    </div>
  );
}

function KindForm({
  kind,
  entry,
  fromEnvironment,
  action,
  probe,
}: {
  kind: ModelKind;
  entry: ProviderModelEntry | null;
  fromEnvironment: boolean;
  action: (
    previous: ModelConfigActionResult | null,
    form: FormData,
  ) => Promise<ModelConfigActionResult>;
  probe: (form: FormData) => Promise<ModelProbeActionResult>;
}) {
  const { t } = useI18n();
  const p = t.admin.models;
  const [state, formAction, pending] = useActionState(action, null);

  /*
   * The probe reads the form the save would post, but is not the form's
   * action: a click on it must not mint a version. Keyed with the form, so a
   * result belongs to the kind it was run for.
   */
  const formRef = useRef<HTMLFormElement>(null);
  const [probing, startProbe] = useTransition();
  const [probed, setProbed] = useState<ModelProbeActionResult | null>(null);
  function runProbe() {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    startProbe(async () => setProbed(await probe(data)));
  }

  const editing = entry ?? BLANK[kind];
  const isNew = entry === null;
  const timeouts = timeoutBoundsFor(kind);

  return (
    <form
      ref={formRef}
      onSubmit={submitOn(formAction)}
      className="flex flex-col gap-4 px-[19px] py-4"
    >
      <input type="hidden" name="kind" value={kind} />
      <p className="text-[12px] tracking-[-0.023em] text-muted">{p.kindNote[kind]}</p>
      {fromEnvironment ? (
        <p className="text-[12px] tracking-[-0.023em] text-muted">{p.environmentNote}</p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={p.label} hint={p.labelHint}>
          <input name="label" defaultValue={editing.label} className={FIELD} required />
        </Field>
        <Field label={p.model}>
          <input name="model" defaultValue={editing.model} className={FIELD} required />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={p.baseUrl} hint={p.baseUrlHint}>
          <input name="baseUrl" defaultValue={editing.baseUrl} className={FIELD} required />
        </Field>
        <Field label={p.apiKey} hint={editing.hasCredential ? p.apiKeyStored : p.apiKeyNew}>
          <input
            name="apiKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={editing.hasCredential ? p.apiKeyKeep : ''}
            className={`${FIELD} font-mono`}
            required={!editing.hasCredential}
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {/* The width belongs to an embedding model and only to one; a
            reranker returns scores, not vectors. */}
        {kind === 'embedding' ? (
          <Field label={p.dimensions} hint={`${p.dimensionsHint} ${range(EMBEDDING_DIMENSIONS)}`}>
            <Bounded
              name="dimensions"
              value={editing.dimensions ?? EMBEDDING_DIMENSIONS.default}
              range={EMBEDDING_DIMENSIONS}
            />
          </Field>
        ) : null}
        <Field label={p.timeoutMs} hint={range(timeouts)}>
          <Bounded name="timeoutMs" value={editing.timeoutMs} range={timeouts} />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-[12px] tracking-[-0.023em] text-steel">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={editing.enabled}
          className="size-4 accent-brand"
        />
        {p.enabled}
      </label>
      <Field label={p.reason}>
        <input name="reason" className={FIELD} required />
      </Field>
      {state && !state.ok ? (
        <p className="text-[12px] tracking-[-0.023em] text-danger">
          {p.errors[state.error ?? 'unavailable']}
        </p>
      ) : null}
      {state?.ok ? <p className="text-[12px] tracking-[-0.023em] text-steel">{p.saved}</p> : null}
      {probed ? <ProbeOutcome result={probed} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <ConsoleButton type="submit" variant="primary" disabled={pending || probing}>
          {isNew ? p.saveNew : p.save}
        </ConsoleButton>
        <ConsoleButton type="button" onClick={runProbe} disabled={pending || probing}>
          {probing ? p.probing : p.probe}
        </ConsoleButton>
        <span className="text-[11px] text-faint">{p.probeHint}</span>
      </div>
    </form>
  );
}

/** What the probe found, in one line: reachable and what came back, or why not. */
function ProbeOutcome({ result }: { result: ModelProbeActionResult }) {
  const { t, locale } = useI18n();
  const p = t.admin.models;
  if (result.kind === 'refused') {
    return (
      <p className="text-[12px] tracking-[-0.023em] text-danger">{p.errors[result.error]}</p>
    );
  }
  const seconds = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    result.latencyMs / 1000,
  );
  if (!result.ok) {
    return (
      <p className="text-[12px] tracking-[-0.023em] text-danger">
        {p.probeFailed} · {seconds} s · {result.error}
      </p>
    );
  }
  return (
    <p className="text-[12px] tracking-[-0.023em] text-steel">
      <span className="font-semibold text-good">{p.probeOk}</span> · {seconds} s ·{' '}
      <span className="font-mono text-ink">{result.detail}</span>
    </p>
  );
}
