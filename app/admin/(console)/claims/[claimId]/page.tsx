import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ClaimControls } from '@/components/admin/claim-controls';
import {
  ConsoleNotice,
  ConsolePageHeader,
  Fact,
  Panel,
  PanelHead,
  Pill,
  TableScroller,
  TD,
  TH,
} from '@/components/admin/ui';
import { CheckIcon, CircleXIcon, ScaleIcon } from '@/components/ui/icons';
import { claimDetail } from '@/lib/application/claims';
import { requireAdminCapability } from '@/lib/http/admin';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import { initialsOf, utcInstant, utcStamp } from '../../list-params';
import { revokeClaimAction, ruleDisputeAction } from '../actions';

type Params = { params: Promise<{ claimId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const [{ claimId }, t] = await Promise.all([params, getMessages()]);
  const claim = await claimDetail(claimId);
  if (!claim) return { title: t.admin.claimDetail.title };
  return { title: fill(t.admin.claimDetail.metaTitle, { asset: claim.asset.title }) };
}

const CLAIM_TONE: Record<string, 'warn' | 'ok' | 'danger' | 'neutral'> = {
  pending: 'warn',
  verified: 'ok',
  failed: 'danger',
  expired: 'neutral',
  revoked: 'neutral',
};

/** A stored enum through its dictionary, with the raw value as the fallback. */
function label(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

/**
 * One claim, with the evidence behind it. requirement.md 5.3, 7.3.5.
 *
 * The evidence is deliberately thin: which method was used, which of its
 * checks passed, how many attempts there were, and when. Not the DNS answer,
 * not the fetched body, not GitHub's permission table -- 7.3.7 keeps those on
 * the server and the check modules never persist them, so there is nothing
 * here to leak even by accident. What an operator needs to rule on a dispute
 * is *whether* control was proved, and that is what a check list says.
 *
 * The three moves live behind the same confirmations the list offers, and the
 * audit panel underneath is the record they write.
 */
export default async function AdminClaimDetailPage({ params }: Params) {
  const [, { claimId }, t] = await Promise.all([
    requireAdminCapability('claims'),
    params,
    getMessages(),
  ]);
  const d = t.admin.claimDetail;

  const claim = await claimDetail(claimId);
  if (!claim) notFound();

  const owner = claim.currentOwner?.name ?? d.unclaimed;

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader
        eyebrow={d.eyebrow}
        title={claim.asset.title}
        description={claim.asset.publicId}
        action={
          <span className="flex flex-wrap items-center gap-2">
            <ClaimControls
              variant="button"
              target={{
                id: claim.id,
                assetTitle: claim.asset.title,
                assetPublicId: claim.asset.publicId,
                claimantName: claim.claimant.name || '—',
                initial: initialsOf(claim.asset.title),
              }}
              status={claim.status}
              disputed={claim.disputed}
              ruleAction={ruleDisputeAction}
              revokeAction={revokeClaimAction}
            />
          </span>
        }
      />

      <Link
        href="/admin/claims"
        className="text-[12px] tracking-[-0.023em] text-muted hover:text-ink"
      >
        {d.back}
      </Link>

      {claim.disputed ? (
        <ConsoleNotice icon={<ScaleIcon size={18} />} title={t.admin.claims.ruleTitle} body={t.admin.claims.rule} />
      ) : null}

      <Panel>
        <PanelHead title={d.factsTitle} description={d.factsSubtitle} />
        <dl className="grid grid-cols-1 gap-x-6 px-[19px] py-1 sm:grid-cols-2">
          <Fact label={d.fields.id} value={<span className="font-mono">{claim.id}</span>} />
          <Fact
            label={d.fields.asset}
            value={
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{claim.asset.publicId}</span>
                {claim.asset.deletedAt ? <Pill tone="danger">{d.assetDeleted}</Pill> : null}
              </span>
            }
          />
          <Fact label={d.fields.claimant} value={claim.claimant.name || '—'} />
          <Fact label={d.fields.currentOwner} value={owner} />
          <Fact
            label={d.fields.source}
            value={
              claim.asset.sourceType
                ? `${claim.asset.sourceType} · ${claim.asset.location ?? '—'}`
                : '—'
            }
          />
          <Fact label={d.fields.method} value={label(d.methods, claim.method)} />
          <Fact
            label={d.fields.status}
            value={
              <span className="flex flex-wrap items-center gap-1.5">
                <Pill tone={CLAIM_TONE[claim.status] ?? 'neutral'}>
                  {label(d.statuses, claim.status)}
                </Pill>
                {claim.disputed ? <Pill tone="warn">{d.disputedBadge}</Pill> : null}
                {claim.expired ? <Pill tone="neutral">{d.expiredBadge}</Pill> : null}
              </span>
            }
          />
          <Fact label={d.fields.attempts} value={String(claim.attempts)} />
          <Fact label={d.fields.createdAt} value={utcInstant(claim.createdAt)} />
          <Fact
            label={d.fields.expiresAt}
            value={
              claim.status === 'pending'
                ? `${utcInstant(claim.expiresAt)} · ${fill(d.remaining, { days: claim.remainingDays })}`
                : utcInstant(claim.expiresAt)
            }
          />
          <Fact label={d.fields.verifiedAt} value={utcInstant(claim.verifiedAt) || '—'} />
          <Fact
            label={d.fields.failureReason}
            value={claim.failureReason ? label(d.reasons, claim.failureReason) : '—'}
          />
          {claim.rulingReason ? (
            <Fact
              label={d.fields.ruling}
              value={fill(d.rulingBy, {
                admin: claim.rulingAdminName ?? t.admin.audit.unknownAdmin,
                reason: claim.rulingReason,
              })}
            />
          ) : null}
        </dl>
      </Panel>

      <Panel>
        <PanelHead title={d.evidenceTitle} description={d.evidenceSubtitle} />
        <ul className="flex flex-col px-[19px]">
          {claim.checks.map((check) => (
            <li
              key={check.key}
              className="flex items-center justify-between gap-4 border-b border-line/70 py-3 last:border-b-0"
            >
              <span className="text-[12px] tracking-[-0.023em] text-steel">
                {label(d.checks, check.key)}
              </span>
              <span
                className={`inline-flex shrink-0 items-center gap-1.5 text-[11.5px] font-semibold tracking-[-0.023em] ${
                  check.state === 'ok'
                    ? 'text-brand'
                    : check.state === 'failed'
                      ? 'text-err'
                      : 'text-faint'
                }`}
              >
                {check.state === 'ok' ? <CheckIcon size={14} /> : null}
                {check.state === 'failed' ? <CircleXIcon size={14} /> : null}
                {d.checkStates[check.state]}
              </span>
            </li>
          ))}
        </ul>
        <p className="border-t-2 border-line px-[19px] py-3 text-[11px] leading-[1.55] tracking-[-0.023em] text-muted">
          {d.evidenceNote}
        </p>
      </Panel>

      <Panel>
        <PanelHead title={d.auditTitle} description={d.auditSubtitle} />
        <TableScroller>
          <table className="w-full min-w-[680px] border-collapse text-left">
            <thead>
              <tr>
                {d.auditColumns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {claim.audit.length === 0 ? (
                <tr className="border-t-2 border-line">
                  <td className={`${TD} text-center text-muted`} colSpan={d.auditColumns.length}>
                    {d.auditEmpty}
                  </td>
                </tr>
              ) : null}
              {claim.audit.map((entry) => (
                <tr key={entry.id} className="border-t-2 border-line">
                  <td className={`${TD} whitespace-nowrap`}>{utcStamp(entry.createdAt)}</td>
                  {/*
                    A claim's own lifecycle -- start, verify, expire -- is
                    written by the claimant or the scheduler, not by an
                    administrator, so the column says so rather than showing
                    an empty cell that reads like missing data.
                  */}
                  <td className={TD}>{entry.administratorName ?? d.auditSystem}</td>
                  <td className={TD}>{label(t.admin.audit.actions, entry.action)}</td>
                  <td className={TD}>{entry.reason ?? '—'}</td>
                  <td className={TD}>{entry.result}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>
      </Panel>
    </div>
  );
}
