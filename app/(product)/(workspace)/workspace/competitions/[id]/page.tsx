import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { entriesMaxFor } from '@/lib/domain/competition';
import { hostCompetition, hostReview } from '@/lib/services/competitions';
import { serverMessages } from '@/i18n/server';
import { FeedColumns } from '@/components/shell/feed-columns';
import { CompetitionEditor } from '@/components/competitions/editor';
import { ReviewBoard } from '@/components/competitions/review-board';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.competitions.editor.editTitle };
}

/**
 * `/workspace/competitions/[id]`: the host's own competition -- its draft
 * to edit and submit, its entries while open, and during review every
 * answer to check and rescore before the results go out (5.1).
 */
export default async function ManageCompetitionPage({ params }: Props) {
  const { id } = await params;
  const [user, { t }] = await Promise.all([currentUser(), serverMessages()]);
  const manage = await hostCompetition(user!.id, id);
  if (!manage) notFound();
  const row = manage.row;
  const c = t.competitions;
  const review = row.status === 'review' ? await hostReview(user!.id, id) : null;
  return (
    <FeedColumns title={row.title} back="/workspace/competitions">
      <div className="flex flex-col gap-6 px-[18px] py-4">
        <p className="flex flex-wrap items-center gap-3 text-[12px]">
          <span className="tag">{c.status[row.status]}</span>
          <Link href={`/competitions/${row.slug}`} className="text-link">
            {c.editor.view}
          </Link>
        </p>
        {review && <ReviewBoard competitionId={id} answers={review.answers} reviewEndsAt={row.reviewEndsAt?.toISOString() ?? null} />}
        <CompetitionEditor
          id={id}
          status={row.status}
          settings={{ title: row.title, channel: row.slug, description: row.description, lang: row.lang, questionMode: row.questionMode, payer: row.payer, maxEntries: row.maxEntries, maxEntriesPerUser: row.maxEntriesPerUser, weights: row.weights, revealReference: row.revealReference, deadlineAt: row.deadlineAt?.toISOString() ?? '', reviewHours: row.reviewHours }}
          questions={manage.questions.map((item) => ({ id: item.id, question: item.question, detail: item.detail, referenceAnswer: item.referenceAnswer, rubric: item.rubric, weight: item.weight }))}
          entries={row.entryCount}
          entriesMax={entriesMaxFor(user!.role)}
          deposit={manage.deposit}
          rejectedReason={row.rejectedReason}
        />
        {manage.entries.length > 0 && (
          <section>
            <h2 className="mb-2 text-[15px] font-semibold">{c.editor.entries}</h2>
            <ul className="flex flex-wrap gap-2">
              {manage.entries.map((entry) => (
                <li key={entry.id} className="tag">
                  {entry.reeName} · {c.workspace.entryStatus[entry.status as keyof typeof c.workspace.entryStatus] ?? entry.status}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </FeedColumns>
  );
}
