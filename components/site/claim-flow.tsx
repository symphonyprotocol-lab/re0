'use client';

import Link from 'next/link';
import { useActionState, useEffect, useId, useState } from 'react';
import type { ClaimFailureReason } from '@/contracts/errors';
import { submitOn } from '@/components/admin/platform-asset-shared';
import { Card, Chip } from '@/components/ui/primitives';
import { CircleCheckIcon, CircleXIcon, CopyIcon, SpinnerIcon } from '@/components/ui/icons';
import type { ClaimMethod, ClaimStatus, SourceType } from '@/lib/domain';
import type { ClaimCheckKey, ClaimCheckView } from '@/lib/domain/claim';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import type { ClaimActionResult } from '@/app/(public)/assets/claim/actions';

type Action = (previous: ClaimActionResult | null, form: FormData) => Promise<ClaimActionResult>;

/** The asset before a claim exists, as the page serialises it. */
export interface ClaimTargetView {
  publicId: string;
  title: string;
  sourceType: SourceType;
  location: string;
  methods: readonly ClaimMethod[];
  ownedByOther: boolean;
  ownedBySelf: boolean;
  ownerName: string | null;
}

/** One claim as its claimant sees it, dates as ISO strings for the wire. */
export interface ClaimView {
  id: string;
  assetPublicId: string;
  assetTitle: string;
  location: string | null;
  method: ClaimMethod;
  status: ClaimStatus;
  failureReason: ClaimFailureReason | null;
  attempts: number;
  expiresAt: string;
  remainingDays: number;
  disputed: boolean;
  checks: ClaimCheckView[];
  dnsRecordName: string | null;
  wellKnownUrl: string | null;
}

const BUTTON =
  'inline-flex h-10 items-center justify-center gap-2 rounded-full px-[18px] text-[14px] font-medium transition-colors disabled:opacity-60';
const PRIMARY = `${BUTTON} bg-brand text-onbrand hover:bg-brand/90`;
const OUTLINE = `${BUTTON} border border-line bg-card text-ink hover:bg-subtle`;

/**
 * The claim flow -- requirement.md 7.3.3, one screen for both halves.
 *
 * With a target and no claim it offers the methods the source admits and
 * opens the claim. The challenge token comes back in the action result and
 * lives only in this component's state: the row keeps its hash, so a reload
 * shows the instructions without the token, and the copy says so. With a
 * claim it shows the instructions, runs the check, and renders the outcome
 * as a stable reason code with the one next step 7.3.8 requires.
 */
export function ClaimFlow({
  target,
  claim,
  grantOutcome,
  startAction,
  verifyAction,
}: {
  target: ClaimTargetView | null;
  claim: ClaimView | null;
  grantOutcome: string | null;
  startAction: Action;
  verifyAction: Action;
}) {
  const [started, setStarted] = useState<ClaimActionResult['challenge'] | null>(null);

  if (claim) {
    return (
      <ClaimPanel claim={claim} token={null} grantOutcome={grantOutcome} verifyAction={verifyAction} />
    );
  }
  if (target && started) {
    const view: ClaimView = {
      id: started.claimId,
      assetPublicId: target.publicId,
      assetTitle: target.title,
      location: target.location,
      method: started.method,
      status: 'pending',
      failureReason: null,
      attempts: 0,
      expiresAt: started.expiresAt,
      remainingDays: 7,
      disputed: started.disputed,
      checks: [],
      dnsRecordName: started.dnsRecordName ?? null,
      wellKnownUrl: started.wellKnownUrl ?? null,
    };
    return (
      <ClaimPanel
        claim={view}
        token={started.challengeToken ?? null}
        grantOutcome={null}
        verifyAction={verifyAction}
      />
    );
  }
  if (target) {
    return (
      <StartPanel
        target={target}
        startAction={startAction}
        onStarted={(challenge) => {
          setStarted(challenge);
          /* A reload lands on the claim, minus the token, which is the rule. */
          window.history.replaceState(null, '', `/assets/claim?claim=${encodeURIComponent(challenge.claimId)}`);
        }}
      />
    );
  }
  return null;
}

/* ------------------------------------------------------------------ start */

function StartPanel({
  target,
  startAction,
  onStarted,
}: {
  target: ClaimTargetView;
  startAction: Action;
  onStarted: (challenge: NonNullable<ClaimActionResult['challenge']>) => void;
}) {
  const { t } = useI18n();
  const c = t.claim;
  const [state, submit, pending] = useActionState(startAction, null);
  const [method, setMethod] = useState<ClaimMethod>(target.methods[0] ?? 'dns_txt');
  const formId = useId();

  useEffect(() => {
    if (state?.ok && state.challenge) onStarted(state.challenge);
  }, [state, onStarted]);

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-2.5 p-4">
        <Fact label={c.asset} value={`${target.title} · ${target.publicId}`} />
        <Fact label={c.source} value={`${target.sourceType} · ${target.location}`} mono />
        <Fact
          label={c.owner}
          value={target.ownerName ?? c.noOwner}
        />
        {target.ownedBySelf ? (
          <Notice tone="good">{c.ownedBySelf}</Notice>
        ) : target.ownedByOther ? (
          <Notice tone="warn">{fill(c.ownedByOther, { owner: target.ownerName ?? '—' })}</Notice>
        ) : null}
      </Card>

      {target.ownedBySelf ? null : (
        <Card className="flex flex-col gap-3 p-4">
          <div>
            <h2 className="text-[15px] font-medium text-ink">{c.methodTitle}</h2>
            <p className="mt-1 text-[12px] text-muted">{c.methodBody}</p>
          </div>

          <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-2.5">
            <input type="hidden" name="assetId" value={target.publicId} />
            {target.methods.map((option, index) => (
              <label
                key={option}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                  method === option ? 'border-brand bg-brandsoft/40' : 'border-line bg-card hover:bg-subtle'
                }`}
              >
                <input
                  type="radio"
                  name="method"
                  value={option}
                  checked={method === option}
                  onChange={() => setMethod(option)}
                  className="mt-1 accent-brand"
                />
                <span className="flex min-w-0 flex-col gap-1">
                  <span
                    className={`text-[13px] text-ink ${index === 0 ? 'font-medium' : 'font-medium'}`}
                  >
                    {c.methods[option].name}
                  </span>
                  <span className="text-[11.5px] leading-[1.6] text-muted">{c.methods[option].note}</span>
                </span>
              </label>
            ))}

            <Refusal state={state} />

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button type="submit" disabled={pending} className={PRIMARY}>
                {pending ? (
                  <>
                    <SpinnerIcon size={15} className="motion-safe:animate-spin" />
                    {c.starting}
                  </>
                ) : (
                  c.start
                )}
              </button>
              <Link href={`/assets/${target.publicId.replace(/^\//, '')}`} className={OUTLINE}>
                {c.backToAsset}
              </Link>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ claim */

function ClaimPanel({
  claim,
  token,
  grantOutcome,
  verifyAction,
}: {
  claim: ClaimView;
  token: string | null;
  grantOutcome: string | null;
  verifyAction: Action;
}) {
  const { locale, t } = useI18n();
  const c = t.claim;
  const [state, submit, pending] = useActionState(verifyAction, null);
  const formId = useId();
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  /* The action's answer wins over what the page loaded; it is newer. */
  const status: ClaimStatus = state?.verified?.status ?? claim.status;
  const disputed = state?.verified?.disputed ?? claim.disputed;
  const reason: ClaimFailureReason | null =
    state && !state.ok ? (state.reason ?? null) : status === 'pending' ? claim.failureReason : claim.failureReason;
  const checks = state?.verified?.checks ?? claim.checks;
  const grantMessage =
    grantOutcome === 'canceled' || grantOutcome === 'failed' ? c.grantOutcome[grantOutcome] : null;
  const grantReason =
    grantOutcome && grantOutcome in c.reasons ? (grantOutcome as ClaimFailureReason) : null;
  const shownReason = reason ?? grantReason;

  const statusTone =
    status === 'verified' ? 'good' : status === 'pending' ? 'warn' : 'neutral';

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-2.5 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-medium text-ink">{c.statusTitle}</h2>
          <Chip tone={statusTone}>{c.statuses[status]}</Chip>
          {disputed && status === 'pending' ? <Chip tone="warn">{t.admin.claimDetail.disputedBadge}</Chip> : null}
        </div>
        <Fact label={c.asset} value={`${claim.assetTitle} · ${claim.assetPublicId}`} />
        <Fact label={t.admin.claimDetail.fields.method} value={c.methods[claim.method].name} />
        {status === 'pending' ? (
          <p className="text-[12px] text-muted">
            {fill(c.remaining, { days: claim.remainingDays })} ·{' '}
            {fill(c.expiresAt, { when: date.format(new Date(claim.expiresAt)) })} ·{' '}
            {fill(c.attempts, { count: claim.attempts + (state?.ok || state?.reason ? 1 : 0) })}
          </p>
        ) : null}
        {status === 'verified' ? (
          <Notice tone="good">{fill(c.verifiedNotice, { asset: claim.assetTitle })}</Notice>
        ) : null}
        {status === 'pending' && state?.ok && disputed ? (
          <Notice tone="good">{c.disputedProven}</Notice>
        ) : status === 'pending' && disputed ? (
          <Notice tone="warn">{c.disputedNotice}</Notice>
        ) : null}
      </Card>

      {status === 'pending' ? (
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="text-[15px] font-medium text-ink">{c.challengeTitle}</h2>

          {claim.method === 'github_permission' ? (
            <>
              <p className="text-[13px] leading-[1.7] text-ink">
                {fill(c.githubStep, { location: claim.location ?? '' })}
              </p>
              <p className="text-[11.5px] text-muted">{c.githubHint}</p>
            </>
          ) : (
            <>
              {token ? (
                <div className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-warnsoft p-3">
                  <p className="text-[12px] leading-[1.6] text-warn">{c.tokenOnce}</p>
                  <TokenField label={c.tokenLabel} value={token} copy={c.copy} copied={c.copied} />
                </div>
              ) : (
                <p className="text-[11.5px] leading-[1.6] text-muted">{c.tokenGone}</p>
              )}
              {claim.method === 'dns_txt' ? (
                <>
                  <p className="text-[13px] leading-[1.7] text-ink">
                    {fill(c.dnsStep, { name: claim.dnsRecordName ?? '_re0-challenge.<domain>' })}
                  </p>
                  {claim.dnsRecordName ? (
                    <TokenField label="TXT" value={claim.dnsRecordName} copy={c.copy} copied={c.copied} />
                  ) : null}
                  <p className="text-[11.5px] text-muted">{c.dnsHint}</p>
                </>
              ) : (
                <>
                  <p className="text-[13px] leading-[1.7] text-ink">
                    {fill(c.wellKnownStep, {
                      url: claim.wellKnownUrl ?? `https://<domain>/.well-known/re0-challenge/${claim.id}`,
                    })}
                  </p>
                  {claim.wellKnownUrl ? (
                    <TokenField label="URL" value={claim.wellKnownUrl} copy={c.copy} copied={c.copied} />
                  ) : null}
                  <p className="text-[11.5px] text-muted">{c.wellKnownHint}</p>
                </>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {claim.method === 'github_permission' ? (
              <form method="post" action={`/api/claims/${encodeURIComponent(claim.id)}/github-grant`}>
                <button type="submit" className={PRIMARY}>
                  {c.githubGrant}
                </button>
              </form>
            ) : (
              <form id={formId} onSubmit={submitOn(submit)}>
                <input type="hidden" name="claimId" value={claim.id} />
                <button type="submit" disabled={pending} className={PRIMARY}>
                  {pending ? (
                    <>
                      <SpinnerIcon size={15} className="motion-safe:animate-spin" />
                      {c.verifying}
                    </>
                  ) : (
                    c.verifyNow
                  )}
                </button>
              </form>
            )}
          </div>
        </Card>
      ) : null}

      {grantMessage ? <Notice tone="warn">{grantMessage}</Notice> : null}
      {state && !state.ok && state.error ? <Notice tone="warn">{c.errors[state.error]}</Notice> : null}

      {/*
        A dispute is not a failed verification: the checks passed and the
        conflict check is waiting on an administrator, which the notice above
        already says. Showing "verification failed / already claimed" beside
        it would contradict it.
      */}
      {shownReason && !(disputed && status === 'pending') ? (
        <Card className="flex flex-col gap-2 border-warn/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <CircleXIcon size={16} className="text-warn" />
            <h2 className="text-[14px] font-medium text-ink">{c.failureTitle}</h2>
            <Chip tone="warn">{c.reasons[shownReason].label}</Chip>
          </div>
          <p className="font-mono text-[11px] text-muted">{fill(c.failureCode, { code: shownReason })}</p>
          <p className="text-[12px] font-medium text-ink">{c.nextStep}</p>
          <p className="text-[12.5px] leading-[1.7] text-muted">{c.reasons[shownReason].next}</p>
          {shownReason === 'challenge_expired' || status !== 'pending' ? (
            <Link
              href={`/assets/claim?asset=${encodeURIComponent(claim.assetPublicId)}`}
              className={`${OUTLINE} mt-1 self-start`}
            >
              {c.newClaim}
            </Link>
          ) : null}
        </Card>
      ) : null}

      {checks.length > 0 ? (
        <Card className="flex flex-col gap-2 p-4">
          <h2 className="text-[14px] font-medium text-ink">{c.checksTitle}</h2>
          <ul className="flex flex-col gap-1.5">
            {checks.map((check) => (
              <li key={check.key} className="flex items-center justify-between gap-3 text-[12px]">
                <span className="text-ink">{c.checks[check.key as ClaimCheckKey]}</span>
                <span
                  className={`inline-flex items-center gap-1 ${
                    check.state === 'ok' ? 'text-good' : check.state === 'failed' ? 'text-warn' : 'text-muted'
                  }`}
                >
                  {check.state === 'ok' ? <CircleCheckIcon size={13} /> : null}
                  {check.state === 'failed' ? <CircleXIcon size={13} /> : null}
                  {c.checkStates[check.state]}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- pieces */

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <span className="text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</span>
      <span className={`text-right text-[12.5px] text-ink ${mono ? 'font-mono text-[11.5px]' : 'font-medium'}`}>
        {value}
      </span>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'good' | 'warn'; children: string }) {
  return (
    <p
      role={tone === 'warn' ? 'alert' : undefined}
      className={`rounded-lg px-3 py-2.5 text-[12px] leading-[1.6] ${
        tone === 'good' ? 'bg-goodsoft text-good' : 'bg-warnsoft text-warn'
      }`}
    >
      {children}
    </p>
  );
}

function TokenField({
  label,
  value,
  copy,
  copied,
}: {
  label: string;
  value: string;
  copy: string;
  copied: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-[52px] shrink-0 text-[10.5px] font-medium tracking-[0.04em] text-muted uppercase">
        {label}
      </span>
      <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-card px-2.5 py-1.5 font-mono text-[11.5px] text-steel">
        {value}
      </code>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => setDone(true),
            () => setDone(false),
          );
        }}
        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-line bg-card px-2 text-[11px] text-ink hover:bg-subtle"
      >
        <CopyIcon size={12} />
        {done ? copied : copy}
      </button>
    </div>
  );
}

function Refusal({ state }: { state: ClaimActionResult | null }) {
  const { t } = useI18n();
  if (!state || state.ok) return null;
  const c = t.claim;
  const text = state.error
    ? c.errors[state.error]
    : state.reason
      ? `${c.reasons[state.reason].label} — ${c.reasons[state.reason].next}`
      : null;
  return text ? <Notice tone="warn">{text}</Notice> : null;
}
