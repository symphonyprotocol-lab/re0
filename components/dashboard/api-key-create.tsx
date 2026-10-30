'use client';

import { useActionState } from 'react';
import { submitOn } from '@/components/admin/platform-library-shared';
import { CopyButton } from '@/components/dashboard/copy-button';
import { PANEL } from '@/components/dashboard/ui';
import type { CreateKeyResult } from '@/app/dashboard/api-keys/actions';
import {
  API_KEY_ENVIRONMENTS,
  API_KEY_MANAGEMENT_SCOPE,
  API_KEY_WRITE_SCOPE,
  API_KEY_SCOPES,
} from '@/lib/domain/api-key';
import { useI18n } from '@/lib/i18n/client';

const FIELD =
  'h-9 rounded-md border border-line bg-card px-2.5 text-[12px] text-ink placeholder:text-muted/70 focus:border-brand focus:outline-none';

/**
 * Key creation, and the one moment the plaintext exists. architecture.md 5.1:
 * the server stores a hash, so this panel is the only place the full key is
 * ever shown -- copy it now or mint another. requirement.md 5.2: a key is
 * named, given an environment and narrowed to scopes at creation; the
 * management scope is listed so its existence is no secret, and disabled
 * because it is reserved.
 */
export function ApiKeyCreate({
  action,
}: {
  action: (previous: CreateKeyResult | null, form: FormData) => Promise<CreateKeyResult>;
}) {
  const { t } = useI18n();
  const k = t.dashboard.apiKeys;
  const s = k.scoped;
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <section className={`${PANEL} flex flex-col gap-3 p-[22px]`}>
      <p className="text-[14px] text-ink">{k.create.title}</p>
      {/* `onSubmit` via submitOn, not `action=`: React resets an uncontrolled
          form when a function action settles, which would clear the typed name
          on a refused create. */}
      <form onSubmit={submitOn(formAction)} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            name="name"
            required
            maxLength={80}
            placeholder={k.create.namePlaceholder}
            className={`${FIELD} min-w-[220px] flex-1`}
          />
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            {s.environment}
            <select name="environment" defaultValue="live" className={`${FIELD} pr-6`}>
              {API_KEY_ENVIRONMENTS.map((environment) => (
                <option key={environment} value={environment}>
                  {s.environments[environment]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={pending}
            className="h-9 shrink-0 rounded-md bg-brand px-4 text-[12px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-60"
          >
            {k.create.submit}
          </button>
        </div>

        <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <legend className="float-left mr-1 text-[11px] text-muted">
            {s.scopes}
          </legend>
          {API_KEY_SCOPES.map((scope) => (
            <label
              key={scope}
              className="flex items-center gap-1.5 text-[12px] text-ink"
            >
              <input
                type="checkbox"
                name="scopes"
                value={scope}
                /* Writes are asked for, never granted by default (lib/domain/api-key.ts). */
                defaultChecked={scope !== API_KEY_WRITE_SCOPE}
                className="size-3.5 accent-brand"
              />
              {s.scopeLabels[scope]}
              <code className="font-mono text-[10px] text-muted">{scope}</code>
            </label>
          ))}
          <label
            className="flex items-center gap-1.5 text-[12px] text-muted"
            title={s.managementScope}
          >
            <input type="checkbox" disabled className="size-3.5" />
            {s.managementScope}
            <code className="font-mono text-[10px]">{API_KEY_MANAGEMENT_SCOPE}</code>
          </label>
        </fieldset>
      </form>

      {state && !state.ok ? (
        <p className="text-[12px] text-rose">
          {state.error === 'limit'
            ? k.create.errorLimit
            : state.error === 'invalid'
              ? k.create.errorInvalid
              : state.error === 'scopes'
                ? s.errorScopes
                : state.error === 'denied'
                  ? s.errorDenied
                  : k.create.errorUnavailable}
        </p>
      ) : null}

      {state?.ok && state.key ? (
        <div className="flex flex-col gap-2 rounded-lg border border-publine bg-pubsoft/40 p-3">
          <p className="text-[12px] font-medium text-ink">
            {k.create.once}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-card px-2 py-1.5 font-mono text-[11.5px] text-steel">
              {state.key}
            </code>
            <CopyButton value={state.key} label={k.create.copy} className="text-steel hover:bg-mutedbg" />
          </div>
        </div>
      ) : null}
    </section>
  );
}
