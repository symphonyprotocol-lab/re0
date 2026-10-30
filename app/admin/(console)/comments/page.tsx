import type { Metadata } from 'next';
import Link from 'next/link';
import { CommentText } from '@/components/creator/comment-text';
import { ConsolePageHeader, EmptyRow, Panel, TableScroller, TD, TH } from '@/components/admin/ui';
import { openCommentReports } from '@/lib/application/comments';
import { requireAdminCapability } from '@/lib/http/admin';
import { translations } from '@/lib/i18n/server';
import { resolveCommentReportAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await translations()).t.creator.admin.comments.metaTitle };
}

const ROW_BUTTON = 'inline-flex h-8 items-center rounded-[7px] px-3 text-[12px] font-medium';

/**
 * Reported comments (agent-first-proposal.md 6.8): what readers flagged,
 * oldest first, with the platform's two rulings. Content review's
 * capability, like the asset catalogue.
 */
export default async function AdminCommentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminCapability('libraries');
  const [{ locale, t }, rows, query] = await Promise.all([translations(), openCommentReports(), searchParams]);
  const p = t.creator.admin.comments;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const notice = typeof query.notice === 'string' ? query.notice : null;

  return (
    <div className="flex flex-col gap-[22px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={p.title} description={p.description} />
      {notice ? <p role="status" className="text-[12px] text-steel">{notice === 'done' ? p.done : notice}</p> : null}
      <Panel>
        <TableScroller>
          <table className="w-full">
            <thead>
              <tr>
                {p.columns.map((column) => (
                  <th key={column} className={TH}>
                    {column}
                  </th>
                ))}
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow columns={5} message={p.empty} />
              ) : (
                rows.map((row) => (
                  <tr key={row.reportId}>
                    <td className={`${TD} max-w-[320px]`}>
                      <CommentText body={row.body} externalLabel={t.creator.comments.external} />
                    </td>
                    <td className={TD}>
                      <Link href={`/assets${row.publicId}#comments`} className="text-brandink hover:underline">
                        {row.assetTitle}
                      </Link>
                    </td>
                    <td className={TD}>{row.reason}</td>
                    <td className={TD}>{date.format(row.reportedAt)}</td>
                    <td className={TD}>
                      <form action={resolveCommentReportAction} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="commentId" value={row.commentId} />
                        <input name="reason" required placeholder={p.reason} className="h-8 rounded-[7px] border-2 border-line bg-field px-2 text-[12px]" />
                        <button type="submit" name="ruling" value="remove" className={`${ROW_BUTTON} bg-rose text-white hover:bg-rose/90`}>
                          {p.remove}
                        </button>
                        <button type="submit" name="ruling" value="dismiss" className={`${ROW_BUTTON} border-2 border-line bg-card text-steel hover:bg-subtle`}>
                          {p.dismiss}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableScroller>
      </Panel>
    </div>
  );
}
