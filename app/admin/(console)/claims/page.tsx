import type { Metadata } from 'next';
import { ClaimControls } from '@/components/admin/claim-controls';
import { FilterSelect } from '@/components/admin/list-controls';
import {
  ConsoleButton,
  ConsoleNotice,
  ConsolePageHeader,
  EmptyRow,
  ExportLink,
  IconLink,
  ListToolbar,
  Pagination,
  Panel,
  Pill,
  TabBar,
  TableScroller,
  TD,
  TH,
  TitleCell,
} from '@/components/admin/ui';
import { EyeIcon, ScaleIcon } from '@/components/ui/icons';
import { listClaims, type ClaimFilter } from '@/lib/application/administration';
import { requireAdminCapability } from '@/lib/http/admin';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import { initialsOf, oneOf, PAGE_SIZE, pageNumber, pageWindow, searchTerm, utcStamp } from '../list-params';
import { revokeClaimAction, ruleDisputeAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.claims.title };
}

const FILTERS: ClaimFilter[] = ['all', 'pending', 'claimed', 'revoked', 'disputed', 'expired'];

const CLAIM_TONE: Record<string, 'warn' | 'ok' | 'danger' | 'neutral'> = {
  pending: 'warn',
  verified: 'ok',
  failed: 'danger',
  expired: 'neutral',
  revoked: 'neutral',
};

/**
 * Ownership claims and disputes -- design source frame `z9DJOF`.
 *
 * `claim_status` has no `disputed` value, and should not: requirement.md 7.3
 * defines a dispute as a claim opened on an asset that already has an owner,
 * which is a fact about the pair rather than a state of the claim. The tab
 * derives it.
 */
/** A stored enum through its dictionary, with the raw value as the fallback. */
function label(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

export default async function AdminClaimsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [, params, t] = await Promise.all([
    requireAdminCapability('claims'),
    searchParams,
    getMessages(),
  ]);
  const c = t.admin.claims;
  const d = t.admin.claimDetail;
  const f = t.admin.filters;
  const query = searchTerm(params.q);
  const status = oneOf(params.status, FILTERS, 'all');
  const page = pageNumber(params.page);

  const { rows, total, counts } = await listClaims({
    query,
    status,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const view = pageWindow({ page, total, rows: rows.length });

  /* One link builder for the tabs and the footer: a tab resets the page. */
  const link = (next: { status?: ClaimFilter; page?: number }) => {
    const search = new URLSearchParams();
    if (query) search.set('q', query);
    const filter = next.status ?? status;
    if (filter !== 'all') search.set('status', filter);
    const target = next.page ?? 1;
    if (target > 1) search.set('page', String(target));
    return `/admin/claims${search.size > 0 ? `?${search.toString()}` : ''}`;
  };
  const href = (next: ClaimFilter) => link({ status: next });

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={c.title} description={c.description} />

      <TabBar
        activeId={status}
        tabs={[
          { id: 'all', label: c.tabs.all, count: counts.all, href: href('all') },
          { id: 'pending', label: c.tabs.pending, count: counts.pending, href: href('pending') },
          { id: 'claimed', label: c.tabs.claimed, count: counts.claimed, href: href('claimed') },
          { id: 'revoked', label: c.tabs.revoked, count: counts.revoked, href: href('revoked') },
          { id: 'disputed', label: c.tabs.disputed, count: counts.disputed, href: href('disputed') },
        ]}
      />

      {/*
        requirement.md 7.3 and 5.3: ownership only follows source verification,
        and an arbitration has to record what it decided on.
      */}
      <ConsoleNotice icon={<ScaleIcon size={18} />} title={c.ruleTitle} body={c.rule} />

      <Panel>
        <form method="get">
          <ListToolbar placeholder={c.searchPlaceholder} name="q" defaultValue={query}>
            <FilterSelect
              name="status"
              label={f.label}
              value={status}
              options={[
                { id: 'all', label: f.all },
                { id: 'pending', label: f.claimPending },
                { id: 'claimed', label: f.claimClaimed },
                { id: 'revoked', label: f.claimRevoked },
                { id: 'disputed', label: f.claimDisputed },
                { id: 'expired', label: f.claimExpired },
              ]}
            />
            <ConsoleButton type="submit">{t.admin.administrators.searchSubmit}</ConsoleButton>
            <ExportLink resource="claims" query={query} status={status} label={t.admin.actions.export} />
          </ListToolbar>
        </form>

        <TableScroller>
          <table className="w-full min-w-[800px] border-collapse text-left">
            <thead>
              <tr>
                {c.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
                <th scope="col" className={`${TH} w-[96px]`}>
                  <span className="sr-only">{t.admin.actions.more}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow
                  columns={c.columns.length + 1}
                  message={c.empty}
                  note={counts.all === 0 ? t.admin.notReady.claims : undefined}
                />
              ) : null}
              {rows.map((claim) => (
                <tr key={claim.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <TitleCell title={claim.assetTitle} meta={claim.assetPublicId} />
                  </td>
                  <td className={TD}>{claim.claimantName || '—'}</td>
                  <td className={`${TD} whitespace-nowrap`}>{label(d.methods, claim.method)}</td>
                  <td className={`${TD} whitespace-nowrap`}>{utcStamp(claim.openedAt)}</td>
                  <td className={TD}>{claim.currentOwner ?? t.adminDemo.unclaimed}</td>
                  <td className={TD}>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Pill tone={CLAIM_TONE[claim.status] ?? 'neutral'}>
                        {label(d.statuses, claim.status)}
                      </Pill>
                      {claim.disputed ? <Pill tone="warn">{d.disputedBadge}</Pill> : null}
                    </span>
                  </td>
                  <td className={TD}>
                    <span className="flex items-center gap-1.5">
                      <IconLink
                        label={t.admin.actions.view}
                        href={`/admin/claims/${encodeURIComponent(claim.id)}`}
                      >
                        <EyeIcon size={14} />
                      </IconLink>
                      <ClaimControls
                        target={{
                          id: claim.id,
                          assetTitle: claim.assetTitle,
                          assetPublicId: claim.assetPublicId,
                          claimantName: claim.claimantName || '—',
                          initial: initialsOf(claim.assetTitle),
                        }}
                        status={claim.status}
                        disputed={claim.disputed}
                        ruleAction={ruleDisputeAction}
                        revokeAction={revokeClaimAction}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>

        <Pagination
          summary={fill(c.showing, { from: view.from, to: view.to, total })}
          pages={view.pages}
          activePage={page}
          pageCount={view.pageCount}
          href={(target) => link({ page: target })}
          labels={t.admin.actions}
        />
      </Panel>
    </div>
  );
}
