import type { Metadata } from 'next';
import { FilterSelect } from '@/components/admin/list-controls';
import {
  ConsoleButton,
  ConsolePageHeader,
  EmptyRow,
  ExportLink,
  IconLink,
  ListToolbar,
  Panel,
  Pill,
  TabBar,
  TableScroller,
  TD,
  TH,
  TitleCell,
} from '@/components/admin/ui';
import { UserReviewControls } from '@/components/admin/user-asset-controls';
import { EyeIcon } from '@/components/ui/icons';
import { listUserAssets, type AssetReviewFilter } from '@/lib/application/administration';
import { requireAdminCapability } from '@/lib/http/admin';
import { fill } from '@/lib/i18n/format';
import type { LifecycleStatus } from '@/lib/domain';
import { getMessages } from '@/lib/i18n/server';
import { bytes, initialsOf, oneOf, PAGE_SIZE, searchTerm, utcStamp } from '../list-params';
import { reviewUserAssetAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.assets.title };
}

const REVIEWS: AssetReviewFilter[] = ['all', 'approved', 'rejected'];

/** How the lifecycle enum reads on screen. requirement.md 5.3, 6.1. */
const LIFECYCLE_TONE: Record<string, 'warn' | 'ok' | 'danger' | 'neutral'> = {
  draft: 'neutral',
  submitted: 'warn',
  reviewing: 'warn',
  changes_requested: 'danger',
  published: 'ok',
  suspended: 'danger',
  archived: 'neutral',
};

/**
 * User assets -- design source frame `zcHnx`.
 *
 * Reads the real `asset` table. Each row carries the platform's verbs
 * that apply to its state (`UserReviewControls`): a live asset offers a
 * suspension, a suspended one its lifting; nothing waits for review since
 * 2026-10-23. The detail page behind the eye shows sources, versions and
 * the history of pauses and suspensions.
 */
export default async function AdminAssetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [, params, t] = await Promise.all([
    requireAdminCapability('assets'),
    searchParams,
    getMessages(),
  ]);
  const l = t.admin.assets;
  const f = t.admin.filters;
  const query = searchTerm(params.q);
  const review = oneOf(params.status, REVIEWS, 'all');

  const { rows, total, counts } = await listUserAssets({ query, review, limit: PAGE_SIZE });

  const href = (status: AssetReviewFilter) => {
    const next = new URLSearchParams();
    if (query) next.set('q', query);
    if (status !== 'all') next.set('status', status);
    return `/admin/assets${next.size > 0 ? `?${next.toString()}` : ''}`;
  };

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={l.title} description={l.description} />

      <TabBar
        activeId={review}
        tabs={[
          { id: 'all', label: l.tabs.all, count: counts.all, href: href('all') },
          { id: 'approved', label: l.tabs.approved, count: counts.approved, href: href('approved') },
          { id: 'rejected', label: l.tabs.rejected, count: counts.rejected, href: href('rejected') },
          { id: 'claims', label: l.tabs.claims, count: counts.claims, href: '/admin/claims' },
        ]}
      />

      <Panel>
        <form method="get">
          <ListToolbar placeholder={l.searchPlaceholder} name="q" defaultValue={query}>
            <FilterSelect
              name="status"
              label={f.label}
              value={review}
              options={[
                { id: 'all', label: f.all },
                { id: 'approved', label: f.reviewApproved },
                { id: 'rejected', label: f.reviewRejected },
              ]}
            />
            <ConsoleButton type="submit">{t.admin.administrators.searchSubmit}</ConsoleButton>
            <ExportLink resource="assets" query={query} status={review} label={t.admin.actions.export} />
          </ListToolbar>
        </form>

        <TableScroller>
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead>
              <tr>
                {l.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
                <th scope="col" className={`${TH} w-[150px]`}>
                  <span className="sr-only">{t.admin.actions.more}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow
                  columns={l.columns.length + 1}
                  message={l.empty}
                  note={counts.all === 0 ? t.admin.notReady.assets : undefined}
                />
              ) : null}
              {rows.map((asset) => (
                <tr key={asset.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <TitleCell
                      title={asset.title}
                      meta={`${asset.publicId} · ${utcStamp(asset.createdAt)}`}
                    />
                  </td>
                  <td className={TD}>{asset.ownerName ?? '—'}</td>
                  <td className={TD}>{asset.sourceType ?? '—'}</td>
                  <td className={`${TD} whitespace-nowrap`}>{bytes(asset.storageBytes)}</td>
                  <td className={TD}>
                    <Pill tone={asset.visibility === 'public' ? 'brand' : 'info'}>
                      {asset.visibility === 'public' ? t.adminDemo.scope.public : t.adminDemo.scope.private}
                    </Pill>
                  </td>
                  <td className={TD}>
                    <Pill tone={LIFECYCLE_TONE[asset.lifecycleStatus] ?? 'neutral'}>
                      {l.lifecycle[asset.lifecycleStatus as keyof typeof l.lifecycle] ??
                        asset.lifecycleStatus}
                    </Pill>
                  </td>
                  <td className={TD}>
                    <span className="flex items-center gap-1.5">
                      <IconLink href={`/admin/assets/${asset.id}`} label={l.view}>
                        <EyeIcon size={14} />
                      </IconLink>
                      <UserReviewControls
                        action={reviewUserAssetAction}
                        target={{
                          id: asset.id,
                          publicId: asset.publicId,
                          title: asset.title,
                          initial: initialsOf(asset.title),
                          sourceLabel: asset.sourceType ?? '—',
                        }}
                        current={asset.lifecycleStatus as LifecycleStatus}
                        visibility={asset.visibility}
                        canApprove={asset.hasReadyVersion}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>

        <div className="border-t-2 border-line px-4 py-[11px]">
          <p className="text-[12px] tracking-[-0.023em] text-muted">
            {fill(l.showing, { from: rows.length === 0 ? 0 : 1, to: rows.length, total })}
          </p>
        </div>
      </Panel>
    </div>
  );
}
