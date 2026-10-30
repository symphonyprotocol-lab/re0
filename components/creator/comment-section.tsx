import Link from 'next/link';
import type { CommentThread, CommentView } from '@/lib/application/comments';
import { COMMENT_LIMITS } from '@/lib/domain/comment';
import type { Dictionary } from '@/lib/i18n/dictionary';
import {
  deleteOwnCommentAction,
  moderateCommentAction,
  postCommentAction,
  reportCommentAction,
  setCommentsClosedAction,
} from '@/app/(public)/assets/comment-actions';
import { CommentText } from './comment-text';

const SMALL = 'text-[11px] text-muted hover:text-ink';

/**
 * An asset's comment section (agent-first-proposal.md 6.8), for whoever is
 * looking: nothing at all where comments do not exist for them; the thread
 * with one level of replies; the write form when they may write; their own
 * delete and a report; and for the creator, the moderation buttons and the
 * close switch. Bodies are untrusted text (`CommentText`).
 */
export function CommentSection({
  assetId,
  publicId,
  thread,
  signedIn,
  outcome,
  t,
  locale,
}: {
  assetId: string;
  publicId: string;
  thread: CommentThread;
  signedIn: boolean;
  outcome: string | null;
  t: Dictionary;
  locale: string;
}) {
  const k = t.creator.comments;
  const errors = t.creator.errors as Record<string, string>;
  const returnTo = `/assets${publicId}`;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const message = outcome === null ? null : ((k.notices as Record<string, string>)[outcome] ?? errors[outcome] ?? errors.unavailable);

  const moderate = (comment: CommentView, action: string, label: string) => (
    <form action={moderateCommentAction}>
      <input type="hidden" name="commentId" value={comment.id} />
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <button type="submit" className={SMALL}>
        {label}
      </button>
    </form>
  );

  const item = (comment: CommentView, reply: boolean) => (
    <li key={comment.id} className={`flex flex-col gap-1.5 ${reply ? 'border-l-2 border-line pl-4' : ''}`}>
      <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span className="font-medium text-ink">{comment.authorName}</span>
        {comment.byCreator ? <span className="rounded-full bg-brandsoft px-1.5 py-0.5 text-[10px] text-brandink">{k.byCreator}</span> : null}
        {comment.pinned ? <span className="text-brandink">{k.pinned}</span> : null}
        <span>{date.format(comment.createdAt)}</span>
        {comment.state === 'hidden' ? <span className="text-rose">{comment.hiddenReason === 'scan' ? k.hiddenScan : k.hidden}</span> : null}
      </p>
      {comment.state === 'deleted' || comment.state === 'removed' ? (
        <p className="text-[12.5px] text-muted italic">{comment.body}</p>
      ) : (
        <CommentText body={comment.body} externalLabel={k.external} />
      )}
      <span className="flex flex-wrap items-center gap-3">
        {comment.mine ? (
          <form action={deleteOwnCommentAction}>
            <input type="hidden" name="commentId" value={comment.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <button type="submit" className={SMALL}>
              {k.delete}
            </button>
          </form>
        ) : null}
        {signedIn && !comment.mine && comment.state === 'visible' ? (
          <details>
            <summary className={`${SMALL} cursor-pointer`}>{k.report}</summary>
            <form action={reportCommentAction} className="mt-1 flex gap-2">
              <input type="hidden" name="commentId" value={comment.id} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <input name="reason" maxLength={COMMENT_LIMITS.reportReasonMax} placeholder={k.reportReason} className="h-7 rounded-md border border-line bg-field px-2 text-[11.5px]" />
              <button type="submit" className={SMALL}>
                {k.report}
              </button>
            </form>
          </details>
        ) : null}
        {thread.viewerIsCreator && comment.state !== 'deleted' && comment.state !== 'removed' ? (
          <>
            {!reply ? (comment.pinned ? moderate(comment, 'unpin', k.unpin) : moderate(comment, 'pin', k.pin)) : null}
            {comment.state === 'hidden' ? moderate(comment, 'unhide', k.unhide) : moderate(comment, 'hide', k.hide)}
            {moderate(comment, 'delete', k.remove)}
            {comment.state === 'visible' ? moderate(comment, 'question', k.toQuestions) : null}
          </>
        ) : null}
      </span>
      {!reply && thread.mayWrite && comment.state === 'visible' ? (
        <details>
          <summary className={`${SMALL} cursor-pointer`}>{k.reply}</summary>
          <form action={postCommentAction} className="mt-1.5 flex flex-col gap-1.5">
            <input type="hidden" name="assetId" value={assetId} />
            <input type="hidden" name="parentId" value={comment.id} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <textarea name="body" required rows={2} maxLength={COMMENT_LIMITS.bodyMax} placeholder={k.replyPlaceholder} className="w-full rounded-md border border-line bg-field px-3 py-2 text-[12.5px]" />
            <button type="submit" className="inline-flex h-7 w-fit items-center rounded-md border border-line bg-card px-2.5 text-[11.5px] text-steel hover:bg-subtle">
              {k.reply}
            </button>
          </form>
        </details>
      ) : null}
      {comment.replies.length > 0 ? <ul className="mt-2 flex flex-col gap-3">{comment.replies.map((child) => item(child, true))}</ul> : null}
    </li>
  );

  return (
    <section id="comments" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[17px] font-medium text-ink">{k.title}</h2>
        {thread.viewerIsCreator ? (
          <form action={setCommentsClosedAction}>
            <input type="hidden" name="assetId" value={assetId} />
            <input type="hidden" name="returnTo" value={returnTo} />
            <input type="hidden" name="closed" value={thread.closed ? 'no' : 'yes'} />
            <button type="submit" className="inline-flex h-8 items-center rounded-md border border-line bg-card px-2.5 text-[11.5px] text-steel hover:bg-subtle">
              {thread.closed ? k.reopen : k.close}
            </button>
          </form>
        ) : null}
      </div>
      {message ? <p role="status" className="text-[12px] text-steel">{message}</p> : null}
      {thread.closed ? <p className="text-[12px] text-muted">{k.closed}</p> : null}
      {thread.mayWrite ? (
        <form action={postCommentAction} className="flex flex-col gap-2">
          <input type="hidden" name="assetId" value={assetId} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <textarea name="body" required rows={3} maxLength={COMMENT_LIMITS.bodyMax} placeholder={k.placeholder} className="w-full rounded-md border border-line bg-field px-3 py-2 text-[13px] text-ink" />
          <button type="submit" className="inline-flex h-8 w-fit items-center rounded-md bg-brand px-3 text-[12px] font-medium text-onbrand hover:bg-brand/90">
            {k.post}
          </button>
        </form>
      ) : !signedIn && !thread.closed ? (
        <Link href={`/login?returnTo=${encodeURIComponent(returnTo)}`} className="text-[12.5px] text-brandink hover:underline">
          {k.signIn}
        </Link>
      ) : null}
      {thread.comments.length === 0 ? (
        <p className="text-[12px] text-muted">{k.empty}</p>
      ) : (
        <ul className="flex flex-col gap-4">{thread.comments.map((comment) => item(comment, false))}</ul>
      )}
    </section>
  );
}
