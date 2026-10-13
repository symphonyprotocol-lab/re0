'use client';

import { useActionState, useRef, useState, useTransition } from 'react';

import { Bounded, FIELD, Field, range } from '@/components/admin/form-fields';
import { submitOn } from '@/components/admin/platform-library-shared';
import { ConsoleButton, Pill } from '@/components/admin/ui';
import type {
  LlmConfigActionResult,
  LlmProbeActionResult,
} from '@/app/admin/(console)/models/actions';
import { useI18n } from '@/lib/i18n/client';
import {
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  priceUsdFromMicro,
  REASONING_EFFORTS,
  TIMEOUT_MS,
  type LlmAudience,
} from '@/lib/domain/generation';

export interface LlmEntry {
  slug: string;
  label: string;
  baseUrl: string;
  model: string;
  /** Whether a credential is stored. The key itself never reaches here. */
  hasCredential: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  promptPriceMicro: number;
  completionPriceMicro: number;
  cachePriceMicro: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
  reasoningEffort: string | null;
  enabled: boolean;
  /** What the assignment in force points at this entry; display only. */
  assignedTo: LlmAudience[];
}

/** What a brand new entry starts from, so the form is never empty. */
const BLANK: LlmEntry = {
  slug: '',
  label: '',
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  hasCredential: false,
  maxInputTokens: 128_000,
  maxOutputTokens: 800,
  timeoutMs: 30_000,
  promptPriceMicro: 0,
  completionPriceMicro: 0,
  cachePriceMicro: 0,
  supportsTools: false,
  supportsReasoning: false,
  supportsVision: false,
  reasoningEffort: null,
  enabled: true,
  assignedTo: [],
};

/**
 * The playground's model registry: what models exist.
 *
 * Every save mints an immutable new row (manage-llm-config.ts), so there is
 * one mutation behind the three things this form does: adding an entry,
 * editing one, and switching one off. Which entry answers whom is the
 * assignment form's decision, not a property of an entry; the badges here
 * only report it. Picking an entry loads it into the form, which means a save
 * with no edits is a faithful re-mint rather than a reset to defaults.
 *
 * `key` on the form is what makes that work: switching entries has to replace
 * the uncontrolled inputs, not merely change the defaults they ignored.
 */
export function LlmConfigForm({
  entries,
  action,
  probe,
}: {
  entries: LlmEntry[];
  action: (previous: LlmConfigActionResult | null, form: FormData) => Promise<LlmConfigActionResult>;
  /** One call against the endpoint as typed, saved or not. */
  probe: (form: FormData) => Promise<LlmProbeActionResult>;
}) {
  const { t } = useI18n();
  const p = t.admin.llm;
  const [state, formAction, pending] = useActionState(action, null);
  const [selected, setSelected] = useState<string | null>(entries[0]?.slug ?? null);

  /*
   * The probe reads the form the save would post, but is not the form's
   * action: a click on it must not mint a version. Its result lives beside
   * the save result and is cleared when a different entry is picked.
   */
  const formRef = useRef<HTMLFormElement>(null);
  const [probing, startProbe] = useTransition();
  const [probed, setProbed] = useState<LlmProbeActionResult | null>(null);
  function runProbe() {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    startProbe(async () => setProbed(await probe(data)));
  }

  const editing = entries.find((entry) => entry.slug === selected) ?? BLANK;
  const isNew = editing === BLANK;

  /*
   * The one field whose availability depends on another. Held in state rather
   * than read off the checkbox, because the effort select has to follow the
   * capability as it is toggled, not only as it was loaded.
   */
  const [reasoning, setReasoning] = useState(editing.supportsReasoning);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap gap-2 px-[19px] pt-4">
        {entries.map((entry) => {
          const active = entry.slug === selected;
          return (
            <button
              key={entry.slug}
              type="button"
              onClick={() => {
                setSelected(entry.slug);
                setReasoning(entry.supportsReasoning);
                setProbed(null);
              }}
              aria-current={active ? 'true' : undefined}
              className={`flex items-center gap-2 rounded-[9px] border-2 px-3 py-2 text-left transition-colors ${
                active ? 'border-brand bg-brandsoft' : 'border-line bg-card hover:bg-subtle'
              }`}
            >
              <span className="flex flex-col gap-0.5">
                <span className="text-[12px] font-semibold tracking-[-0.023em] text-ink">
                  {entry.label}
                </span>
                <span className="font-mono text-[10.5px] text-faint">{entry.model}</span>
              </span>
              {entry.assignedTo.map((audience) => (
                <Pill key={audience} tone={audience === 'subscriber' ? 'brand' : 'ok'}>
                  {p.audiences[audience]}
                </Pill>
              ))}
              {entry.enabled ? null : <Pill tone="neutral">{p.stateDisabled}</Pill>}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => {
            setSelected(null);
            setReasoning(BLANK.supportsReasoning);
            setProbed(null);
          }}
          aria-current={isNew ? 'true' : undefined}
          className={`rounded-[9px] border-2 border-dashed px-3 py-2 text-[12px] font-semibold tracking-[-0.023em] transition-colors ${
            isNew ? 'border-brand text-brandink' : 'border-line text-muted hover:text-ink'
          }`}
        >
          {p.newEntry}
        </button>
      </div>

      <form
        key={editing.slug || 'new'}
        ref={formRef}
        onSubmit={submitOn(formAction)}
        className="flex flex-col gap-4 px-[19px] py-4"
      >
        {editing.slug ? <input type="hidden" name="slug" value={editing.slug} /> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={p.label} hint={isNew ? p.labelHint : editing.slug}>
            <input name="label" defaultValue={editing.label} className={FIELD} required />
          </Field>
          <Field label={p.model}>
            <input name="model" defaultValue={editing.model} className={FIELD} required />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={p.baseUrl}>
            <input name="baseUrl" defaultValue={editing.baseUrl} className={FIELD} required />
          </Field>
          {/* Always empty on load, and blank means keep the stored key:
              pre-filling it would mean sending a provider secret to the
              browser, and re-typing one to change a price is how keys end up
              somewhere they can be copied from. */}
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
          <Field label={p.maxInputTokens} hint={p.maxInputTokensHint}>
            <Bounded name="maxInputTokens" value={editing.maxInputTokens} range={MAX_INPUT_TOKENS} />
          </Field>
          <Field label={p.maxOutputTokens} hint={range(MAX_OUTPUT_TOKENS)}>
            <Bounded
              name="maxOutputTokens"
              value={editing.maxOutputTokens}
              range={MAX_OUTPUT_TOKENS}
            />
          </Field>
          <Field label={p.timeoutMs} hint={`${p.timeoutMsHint} ${range(TIMEOUT_MS)}`}>
            <Bounded name="timeoutMs" value={editing.timeoutMs} range={TIMEOUT_MS} />
          </Field>
          <Field label={p.promptPrice}>
            <PriceInput name="promptPriceUsd" micro={editing.promptPriceMicro} />
          </Field>
          <Field label={p.completionPrice}>
            <PriceInput name="completionPriceUsd" micro={editing.completionPriceMicro} />
          </Field>
          <Field label={p.cachePrice} hint={p.cachePriceHint}>
            <PriceInput name="cachePriceUsd" micro={editing.cachePriceMicro} />
          </Field>
        </div>

        <fieldset className="flex flex-col gap-3 rounded-[9px] border-2 border-line px-3 py-2.5">
          <legend className="px-1 text-[11px] font-semibold tracking-[-0.023em] text-steel">
            {p.capabilities}
          </legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Capability name="supportsTools" label={p.capTools} checked={editing.supportsTools} />
            <Capability
              name="supportsReasoning"
              label={p.capReasoning}
              checked={editing.supportsReasoning}
              onChange={setReasoning}
            />
            <Capability name="supportsVision" label={p.capVision} checked={editing.supportsVision} />
          </div>
          <Field label={p.reasoningEffort} hint={reasoning ? undefined : p.reasoningEffortHint}>
            <select
              name="reasoningEffort"
              defaultValue={editing.reasoningEffort ?? ''}
              disabled={!reasoning}
              className={`${FIELD} disabled:opacity-50`}
            >
              <option value="">{p.effortUnset}</option>
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {p.efforts[effort]}
                </option>
              ))}
            </select>
          </Field>
        </fieldset>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-[12px] tracking-[-0.023em] text-steel">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={editing.enabled}
              className="size-4 accent-brand"
            />
            {p.enabled}
          </label>
        </div>
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
    </div>
  );
}

/** What the probe found, in one line: reachable and what it said, or why not. */
function ProbeOutcome({ result }: { result: LlmProbeActionResult }) {
  const { t, locale } = useI18n();
  const p = t.admin.llm;
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
      {result.promptTokens} / {result.completionTokens} tokens · {p.probeReply}{' '}
      <span className="font-mono text-ink">{result.reply}</span>
    </p>
  );
}

/**
 * A unit price, in dollars per million tokens.
 *
 * The row holds micro-USD, so the value is converted on the way in and the
 * action converts it back on the way out; the `Usd` suffix on the field name
 * is what keeps the two units from being posted into each other. `step="any"`
 * because provider price lists are not on a fixed grid -- $0.075 and $1.25 are
 * both real -- and a step would make the browser reject them.
 */
function PriceInput({ name, micro }: { name: string; micro: number }) {
  return (
    <span className="relative block">
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[12px] text-faint"
      >
        $
      </span>
      <input
        name={name}
        type="number"
        min={0}
        step="any"
        defaultValue={priceUsdFromMicro(micro)}
        className={`${FIELD} pl-5`}
      />
    </span>
  );
}

/** A declared ability. `onChange` only where another field depends on it. */
function Capability({
  name,
  label,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  checked: boolean;
  onChange?: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px] tracking-[-0.023em] text-steel">
      <input
        type="checkbox"
        name={name}
        defaultChecked={checked}
        onChange={onChange ? (event) => onChange(event.target.checked) : undefined}
        className="size-4 accent-brand"
      />
      {label}
    </label>
  );
}
