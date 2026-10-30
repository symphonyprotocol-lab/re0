import type { Metadata } from 'next';
import Link from 'next/link';
import { CommentText } from '@/components/creator/comment-text';
import { PANEL, PageHeader, StatusLabel } from '@/components/dashboard/ui';
import { workspaceComments } from '@/lib/application/comments';
import { canManageLibraries } from '@/lib/application/libraries';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { moderateCommentAction } from '@/app/(public)/assets/comment-actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).creator.dashboard.comments.metaTitle };
}

const SMALL = 'inline-flex h-8 items-center rounded-md border border-line bg-card px-2.5 text-[11.5px] font-medium text-steel hover:bg-subtle';

/**
 * 评论管理 (agent-first-proposal.md 6.8): every comment on the workspace's
 * channel assets, newest first, with what the content check held and how
 * many open reports each has. Moderation acts through the same use cases
 * as the buttons under each asset.
 */
export default async function CommentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [session, { locale, t }, query] = await Promise.all([requireSession('/dashboard/comments'), translations(), searchParams]);
  const c = t.creator.dashboard.comments;
  const k = t.creator.comments;
  const errors = t.creator.errors as Record<string, string>;
  const rows = await workspaceComments(session.workspace.id);
  const canEdit = canManageLibraries(session.workspace.role);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const outcome = typeof query.comment === 'string' ? query.comment : null;
  const message = outcome === null ? null : ((k.notices as Record<string, string>)[outcome] ?? errors[outcome] ?? errors.unavailable);

  const button = (commentId: string, action: string, label: string) => (
    <form action={moderateCommentAction}>
      <input type="hidden" name="commentId" value={commentId} />
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="returnTo" value="/dashboard/comments" />
      <button type="submit" className={SMALL}>
        {label}
      </button>
    </form>
  );

  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader eyebrow={session.workspace.name} title={c.title} description={c.description} />
      {message ? <p role="status" className="text-[12.5px] text-steel">{message}</p> : null}
      {rows.length === 0 ? (
        <p className={`${PANEL} px-6 py-10 text-center text-[12.5px] text-muted`}>{c.empty}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.id} className={`${PANEL} flex flex-col gap-2 p-4`}>
              <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <Link href={`/assets${row.publicId}#comments`} className="font-medium text-ink hover:text-brandink">
                  {row.assetTitle}
                </Link>
                <span>{row.authorName ?? 'Reader'}</span>
                <span>{date.format(row.createdAt)}</span>
                {row.pinnedAt ? <span className="text-brandink">{k.pinned}</span> : null}
                {row.state === 'hidden' ? (
                  <StatusLabel tone="blocked">{row.hiddenReason === 'scan' ? k.hiddenScan : k.hidden}</StatusLabel>
                ) : null}
                {row.reports > 0 ? <StatusLabel tone="pending">{fill(c.reports, { count: String(row.reports) })}</StatusLabel> : null}
              </p>
              <CommentText body={row.body} externalLabel={k.external} />
              {canEdit ? (
                <span className="flex flex-wrap gap-2">
                  {row.parentId ? null : row.pinnedAt ? button(row.id, 'unpin', k.unpin) : button(row.id, 'pin', k.pin)}
                  {row.state === 'hidden' ? button(row.id, 'unhide', k.unhide) : button(row.id, 'hide', k.hide)}
                  {button(row.id, 'delete', k.remove)}
                  {row.state === 'visible' ? button(row.id, 'question', k.toQuestions) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
