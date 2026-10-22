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
import { UserReviewControls } from '@/components/admin/user-library-controls';
import { EyeIcon } from '@/components/ui/icons';
import { listUserLibraries, type LibraryReviewFilter } from '@/lib/application/administration';
import { requireAdminCapability } from '@/lib/http/admin';
import { fill } from '@/lib/i18n/format';
import type { LifecycleStatus } from '@/lib/domain';
import { getMessages } from '@/lib/i18n/server';
import { bytes, initialsOf, oneOf, PAGE_SIZE, searchTerm, utcStamp } from '../list-params';
import { reviewUserLibraryAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.libraries.title };
}

const REVIEWS: LibraryReviewFilter[] = ['all', 'pending', 'approved', 'rejected', 'sample'];

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
 * User libraries and the public review queue -- design source frame `zcHnx`.
 *
 * Reads the real `library` table. Each row carries the reviewer's verbs that
 * apply to its state (`UserReviewControls`): a public library that has built
 * its first version waits here as `submitted`; a private one is never
 * reviewed and only offers a safety pause. The detail page behind the eye
 * shows sources, versions and the review history.
 */
export default async function AdminLibrariesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [, params, t] = await Promise.all([
    requireAdminCapability('libraries'),
    searchParams,
    getMessages(),
  ]);
  const l = t.admin.libraries;
  const f = t.admin.filters;
  const query = searchTerm(params.q);
  const review = oneOf(params.status, REVIEWS, 'all');

  const { rows, total, counts } = await listUserLibraries({ query, review, limit: PAGE_SIZE });

  const href = (status: LibraryReviewFilter) => {
    const next = new URLSearchParams();
    if (query) next.set('q', query);
    if (status !== 'all') next.set('status', status);
    return `/admin/libraries${next.size > 0 ? `?${next.toString()}` : ''}`;
  };

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={l.title} description={l.description} />

      <TabBar
        activeId={review}
        tabs={[
          { id: 'all', label: l.tabs.all, count: counts.all, href: href('all') },
          { id: 'pending', label: l.tabs.pending, count: counts.pending, href: href('pending') },
          { id: 'approved', label: l.tabs.approved, count: counts.approved, href: href('approved') },
          { id: 'rejected', label: l.tabs.rejected, count: counts.rejected, href: href('rejected') },
          { id: 'sample', label: l.tabs.sample, count: counts.sample, href: href('sample') },
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
                { id: 'pending', label: f.reviewPending },
                { id: 'approved', label: f.reviewApproved },
                { id: 'rejected', label: f.reviewRejected },
              ]}
            />
            <ConsoleButton type="submit">{t.admin.administrators.searchSubmit}</ConsoleButton>
            <ExportLink resource="libraries" query={query} status={review} label={t.admin.actions.export} />
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
                  note={counts.all === 0 ? t.admin.notReady.libraries : undefined}
                />
              ) : null}
              {rows.map((library) => (
                <tr key={library.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <TitleCell
                      title={library.title}
                      meta={`${library.publicId} · ${utcStamp(library.createdAt)}`}
                    />
                  </td>
                  <td className={TD}>{library.ownerName ?? '—'}</td>
                  <td className={TD}>{library.sourceType ?? '—'}</td>
                  <td className={`${TD} whitespace-nowrap`}>{bytes(library.storageBytes)}</td>
                  <td className={TD}>
                    <Pill tone={library.visibility === 'public' ? 'brand' : 'info'}>
                      {library.visibility === 'public' ? t.adminDemo.scope.public : t.adminDemo.scope.private}
                    </Pill>
                  </td>
                  <td className={TD}>
                    <Pill tone={LIFECYCLE_TONE[library.lifecycleStatus] ?? 'neutral'}>
                      {l.lifecycle[library.lifecycleStatus as keyof typeof l.lifecycle] ??
                        library.lifecycleStatus}
                    </Pill>
                  </td>
                  <td className={TD}>
                    <span className="flex items-center gap-1.5">
                      <IconLink href={`/admin/libraries/${library.id}`} label={l.view}>
                        <EyeIcon size={14} />
                      </IconLink>
                      <UserReviewControls
                        action={reviewUserLibraryAction}
                        target={{
                          id: library.id,
                          publicId: library.publicId,
                          title: library.title,
                          initial: initialsOf(library.title),
                          sourceLabel: library.sourceType ?? '—',
                        }}
                        current={library.lifecycleStatus as LifecycleStatus}
                        visibility={library.visibility}
                        canApprove={library.hasReadyVersion}
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
