import type { Metadata } from 'next';
import Link from 'next/link';
import { AppError } from '@/contracts/errors';
import { ClaimFlow, type ClaimTargetView, type ClaimView } from '@/components/site/claim-flow';
import { Button, Card, Chip, SectionHeading } from '@/components/ui/primitives';
import {
  claimForClaimant,
  claimTarget,
  listWorkspaceClaims,
  type ClaimantClaimView,
  type ClaimTarget,
} from '@/lib/application/claims';
import { remainingDays } from '@/lib/domain/claim';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { startClaimAction, verifyClaimAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).claim.metaTitle };
}

type Search = {
  searchParams: Promise<{ asset?: string; claim?: string; grant?: string }>;
};

const one = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '');

/**
 * The claim screen. requirement.md 5.3, 7.3.
 *
 * Three shapes, one route, because they are three moments of one errand:
 *
 * - `?claim=<id>`  an open claim -- its instructions, its check, its outcome.
 * - `?asset=<id>` an asset to claim -- the methods its source admits.
 * - neither         where to find an asset, plus the claims already opened.
 *
 * A claim belongs to a workspace, so the page is behind the session: an
 * anonymous visitor is sent to sign in and comes back here rather than to the
 * dashboard. The asset id travels in the return path, so the errand
 * survives the round trip.
 *
 * Nothing on this page decides anything. `startClaim` and `verifyClaim` do,
 * behind the two server actions, and the page only renders what the read
 * models say -- including the failure code and its one next step, which is
 * the whole of what 7.3.8 lets a claimant see.
 */
export default async function ClaimPage({ searchParams }: Search) {
  const params = await searchParams;
  const assetId = one(params.asset);
  const claimId = one(params.claim);

  const returnTo = claimId
    ? `/assets/claim?claim=${encodeURIComponent(claimId)}`
    : assetId
      ? `/assets/claim?asset=${encodeURIComponent(assetId)}`
      : '/assets/claim';

  const [session, { locale, t }] = await Promise.all([requireSession(returnTo), translations()]);
  const c = t.claim;

  /*
   * An asset the caller cannot see and one that does not exist answer the
   * same way (7.3.7), so both land on one sentence rather than a 404 that
   * would confirm the id.
   */
  let target: ClaimTarget | null = null;
  let claim: ClaimantClaimView | null = null;
  let missing = false;
  try {
    if (claimId) claim = await claimForClaimant(session.workspace.id, claimId);
    else if (assetId) target = await claimTarget(session.workspace.id, assetId);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    missing = true;
  }

  const claims = claim || target ? [] : await listWorkspaceClaims(session.workspace.id);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const now = new Date();

  const targetView: ClaimTargetView | null = target
    ? {
        publicId: target.publicId,
        title: target.title,
        sourceType: target.sourceType,
        location: target.location,
        methods: target.methods,
        ownedByOther: target.ownedByOther,
        ownedBySelf: target.ownedBySelf,
        ownerName: target.ownerName,
      }
    : null;

  const claimView: ClaimView | null = claim
    ? {
        id: claim.id,
        assetPublicId: claim.assetPublicId,
        assetTitle: claim.assetTitle,
        location: claim.location,
        method: claim.method,
        status: claim.status,
        failureReason: claim.failureReason,
        attempts: claim.attempts,
        expiresAt: claim.expiresAt.toISOString(),
        remainingDays: remainingDays(claim.expiresAt, now),
        disputed: claim.disputed,
        checks: claim.checks,
        dnsRecordName: claim.dnsRecordName,
        wellKnownUrl: claim.wellKnownUrl,
      }
    : null;

  return (
    <section className="mx-auto w-full max-w-[918px] px-5 pt-11 pb-16">
      <SectionHeading eyebrow={c.eyebrow} title={c.title} />
      <p className="mt-4 max-w-[80ch] text-[13px] leading-[1.7] text-muted">{c.description}</p>

      <div className="mt-7 flex flex-col gap-4">
        {missing ? (
          <Card className="flex flex-col items-start gap-3 p-5">
            <p role="alert" className="text-[13px] leading-[1.7] text-warn">
              {c.errors.not_found}
            </p>
            <Button href="/channels" variant="outline">
              {c.browseCatalog}
            </Button>
          </Card>
        ) : null}

        {targetView || claimView ? (
          <ClaimFlow
            target={targetView}
            claim={claimView}
            grantOutcome={one(params.grant) || null}
            startAction={startClaimAction}
            verifyAction={verifyClaimAction}
          />
        ) : null}

        {claimView || targetView ? null : (
          <>
            {missing ? null : (
              <Card className="flex flex-col items-start gap-3 p-5">
                <h2 className="text-[15px] font-medium text-ink">
                  {c.pickTitle}
                </h2>
                <p className="max-w-[70ch] text-[12.5px] leading-[1.7] text-muted">{c.pickBody}</p>
                <Button href="/channels" variant="outline">
                  {c.browseCatalog}
                </Button>
              </Card>
            )}

            <Card className="overflow-hidden">
              <div className="border-b border-line px-4 py-3">
                <h2 className="text-[13.5px] font-medium text-ink">
                  {c.yourClaims}
                </h2>
              </div>
              {claims.length === 0 ? (
                <p className="px-4 py-8 text-center text-[12.5px] text-muted">{c.yourClaimsEmpty}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] border-collapse text-left">
                    <thead>
                      <tr>
                        {c.columns.map((column, index) => (
                          <th
                            key={column || `col-${index}`}
                            scope="col"
                            className="border-b border-line px-4 py-2.5 text-[11px] font-medium tracking-[0.02em] text-muted"
                          >
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {claims.map((row) => (
                        <tr key={row.id} className="border-b border-line/70 last:border-b-0">
                          <td className="px-4 py-3">
                            <span className="flex min-w-0 flex-col gap-0.5">
                              <span className="truncate text-[12.5px] font-medium text-ink">
                                {row.assetTitle}
                              </span>
                              <span className="truncate font-mono text-[10.5px] text-muted">
                                {row.assetPublicId}
                              </span>
                            </span>
                          </td>
                          <td className="px-4 py-3 text-[12px] text-steel">
                            {c.methods[row.method].name}
                          </td>
                          <td className="px-4 py-3">
                            <span className="flex flex-wrap items-center gap-1.5">
                              <Chip
                                tone={
                                  row.status === 'verified'
                                    ? 'good'
                                    : row.status === 'pending'
                                      ? 'warn'
                                      : 'neutral'
                                }
                              >
                                {c.statuses[row.status]}
                              </Chip>
                              {row.disputed ? (
                                <Chip tone="warn">{t.admin.claimDetail.disputedBadge}</Chip>
                              ) : null}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-[12px] whitespace-nowrap text-muted">
                            {row.status === 'pending'
                              ? fill(c.remaining, { days: remainingDays(row.expiresAt, now) })
                              : date.format(row.expiresAt)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Link
                              href={`/assets/claim?claim=${encodeURIComponent(row.id)}`}
                              className="text-[12px] font-medium text-brandink hover:underline"
                            >
                              {c.open}
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </section>
  );
}
