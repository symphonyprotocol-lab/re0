'use client';

import { useActionState, useState } from 'react';
import {
  manageAgentAction,
  registerAgentAction,
  saveCredentialAction,
  type RegistryResult,
} from '@/app/dashboard/external-agents/actions';
import type { ExternalAgentView } from '@/lib/application/external-agents/registry';
import { useI18n } from '@/lib/i18n/client';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';

type Words = Dictionary['dashboard']['externalAgents'];

const INPUT = 'h-9 w-full rounded-md border border-line bg-card px-3 text-[12.5px] text-ink outline-none focus:border-brand';
const PRIMARY =
  'h-9 shrink-0 rounded-md bg-brand px-3.5 text-[12px] font-medium text-onbrand transition-opacity hover:opacity-90 disabled:opacity-50';
const SECONDARY =
  'h-8 rounded-md border border-line px-3 text-[11.5px] text-ink transition-colors hover:bg-subtle disabled:opacity-50';

function Refusal({ result, e }: { result: RegistryResult | null; e: Words['errors'] }) {
  if (!result?.error) return null;
  return (
    <p role="alert" className="mt-1.5 text-[11.5px] text-warn">
      {e[result.error as keyof Words['errors']] ?? e.unavailable}
    </p>
  );
}

/** The card URL form (proposal 7.9): the server fetches and checks the card. */
export function RegisterAgentForm() {
  const { t } = useI18n();
  const x = t.dashboard.externalAgents;
  const [result, register, registering] = useActionState<RegistryResult | null, FormData>(registerAgentAction, null);
  return (
    <form action={register} className="flex flex-col gap-1.5">
      <label htmlFor="cardUrl" className="text-[11.5px] font-medium text-ink">
        {x.cardUrl}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input id="cardUrl" name="cardUrl" type="url" required placeholder="https://" className={INPUT} autoComplete="off" />
        <button type="submit" disabled={registering} className={PRIMARY}>
          {registering ? x.registering : x.submit}
        </button>
      </div>
      <p className="text-[11px] text-faint">{x.cardUrlHint}</p>
      {result?.ok ? <p className="text-[11.5px] text-brandink">{x.registered}</p> : null}
      <Refusal result={result} e={x.errors} />
    </form>
  );
}

function ManageButton({ agentId, op, label, x }: { agentId: string; op: string; label: string; x: Words }) {
  const [result, manage, pending] = useActionState<RegistryResult | null, FormData>(manageAgentAction, null);
  return (
    <form action={manage}>
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="op" value={op} />
      <button type="submit" disabled={pending} className={SECONDARY}>
        {label}
      </button>
      <Refusal result={result} e={x.errors} />
    </form>
  );
}

/** Removing asks twice: the credential goes with it. */
function RemoveButton({ agentId, x }: { agentId: string; x: Words }) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button type="button" onClick={() => setArmed(true)} className={`${SECONDARY} text-warn`}>
        {x.remove}
      </button>
    );
  }
  return <ManageButton agentId={agentId} op="remove" label={x.removeConfirm} x={x} />;
}

/**
 * The credential box: saved as typed, then never shown again -- only its
 * kind, last four characters and version. The input is a password field and
 * is cleared by the re-render after a save.
 */
function CredentialForm({ agent, x }: { agent: ExternalAgentView; x: Words }) {
  const [result, save, saving] = useActionState<RegistryResult | null, FormData>(saveCredentialAction, null);
  const defaultKind = Object.values(agent.schemes).some((scheme) => scheme.kind === 'api_key') &&
    !Object.values(agent.schemes).some((scheme) => scheme.kind === 'bearer')
    ? 'api_key'
    : 'bearer';
  return (
    <form action={save} className="mt-2 flex flex-col gap-1.5">
      <input type="hidden" name="agentId" value={agent.id} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <select name="kind" defaultValue={agent.credential?.kind ?? defaultKind} className={`${INPUT} sm:w-40`}>
          <option value="bearer">{x.kinds.bearer}</option>
          <option value="api_key">{x.kinds.api_key}</option>
        </select>
        <input
          name="secret"
          type="password"
          required
          minLength={8}
          maxLength={4096}
          autoComplete="off"
          aria-label={x.secret}
          placeholder={x.secret}
          className={INPUT}
        />
        <button type="submit" disabled={saving} className={PRIMARY}>
          {agent.credential ? x.rotateCredential : x.saveCredential}
        </button>
      </div>
      <p className="text-[11px] text-faint">{x.secretHint}</p>
      {result?.ok ? <p className="text-[11.5px] text-brandink">{x.saved}</p> : null}
      <Refusal result={result} e={x.errors} />
    </form>
  );
}

export function ExternalAgentCard({ agent }: { agent: ExternalAgentView }) {
  const { locale, t } = useI18n();
  const x = t.dashboard.externalAgents;
  const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const schemes = Object.entries(agent.schemes);
  const credential = agent.credential;

  return (
    <article className="rounded-lg border border-line bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-ink">{agent.name}</p>
          <p className="mt-0.5 font-mono text-[11px] break-all text-muted">{agent.cardUrl}</p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
            agent.status === 'active' ? 'bg-brandsoft text-brandink' : 'bg-subtle text-muted'
          }`}
        >
          {x.status[agent.status]}
        </span>
      </div>
      {agent.description ? <p className="mt-2 text-[12px] leading-[1.6] text-muted">{agent.description}</p> : null}

      <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-[11.5px] text-muted sm:grid-cols-[auto_1fr]">
        {agent.providerName ? (
          <>
            <dt className="text-faint">{x.provider}</dt>
            <dd>{agent.providerName}</dd>
          </>
        ) : null}
        <dt className="text-faint">{x.endpoints}</dt>
        <dd className="flex flex-col gap-0.5">
          {agent.endpoints.map((endpoint) => (
            <span key={`${endpoint.binding}-${endpoint.url}`} className="font-mono text-[10.5px] break-all">
              {endpoint.binding} · A2A {endpoint.protocolVersion} · {endpoint.url}
            </span>
          ))}
        </dd>
        <dt className="text-faint">{x.skills}</dt>
        <dd>
          {agent.skills.length === 0 ? (
            x.noSkills
          ) : (
            <ul className="flex flex-col gap-0.5">
              {agent.skills.map((skill) => (
                <li key={skill.id}>
                  <span className="font-mono text-[10.5px] text-ink">{skill.id}</span> · {skill.name}
                  {skill.description ? <span className="text-faint"> — {skill.description}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt className="text-faint">{x.auth}</dt>
        <dd>
          {schemes.length === 0
            ? x.authNone
            : schemes
                .map(([name, scheme]) =>
                  scheme.kind === 'unsupported'
                    ? `${name}: ${fill(x.authUnsupported, { type: scheme.type })}`
                    : `${name}: ${x.kinds[scheme.kind]}${scheme.kind === 'api_key' && scheme.header ? ` (${scheme.header})` : ''}`,
                )
                .join('; ')}
        </dd>
      </dl>
      <p className="mt-1.5 text-[10.5px] text-faint">{fill(x.fetchedAt, { time: time.format(new Date(agent.fetchedAt)) })}</p>

      <section className="mt-3 border-t border-line pt-3">
        <p className="text-[12px] font-medium text-ink">{x.credentialTitle}</p>
        {credential ? (
          <>
            <p className="mt-1 text-[11.5px] text-muted">
              {fill(credential.suffix ? x.credentialSaved : x.credentialSavedMasked, {
                kind: x.kinds[credential.kind],
                suffix: credential.suffix ?? '',
                version: String(credential.version),
                time: time.format(new Date(credential.updatedAt)),
              })}
            </p>
            <p className="text-[11px] text-faint">{fill(x.credentialHeader, { header: credential.header })}</p>
          </>
        ) : (
          <p className={`mt-1 text-[11.5px] ${agent.requiresCredential ? 'text-warn' : 'text-muted'}`}>
            {agent.requiresCredential ? x.credentialNeeded : x.credentialNone}
          </p>
        )}
        <CredentialForm agent={agent} x={x} />
        {credential ? (
          <div className="mt-2">
            <ManageButton agentId={agent.id} op="delete-credential" label={x.deleteCredential} x={x} />
          </div>
        ) : null}
      </section>

      <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
        <ManageButton agentId={agent.id} op="refetch" label={x.refetch} x={x} />
        <ManageButton
          agentId={agent.id}
          op={agent.status === 'active' ? 'disable' : 'enable'}
          label={agent.status === 'active' ? x.disable : x.enable}
          x={x}
        />
        <RemoveButton agentId={agent.id} x={x} />
      </div>
    </article>
  );
}
