import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { entrySheet } from '@/lib/services/competitions';
import { PRIVATE_ROBOTS, UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime } from '@/i18n/format';
import { FeedColumns } from '@/components/shell/feed-columns';
import { CompetitionMarkdown } from '@/components/competitions/competition-markdown';

type Props = { params: Promise<{ slug: string; entryId: string }> };

const decoded = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ slug, entryId }, user, { t }] = await Promise.all([params, currentUser(), serverMessages()]);
  const sheet = await entrySheet(decoded(slug), entryId, user?.id);
  if (!sheet) return { robots: PRIVATE_ROBOTS };
  return { title: fill(t.competitions.sheet.title, { ree: sheet.entry.reeName }), robots: sheet.scored ? UNLISTED_ROBOTS : PRIVATE_ROBOTS };
}

/**
 * `/competitions/[slug]/entries/[entryId]`: one Ree's answers -- each with
 * its score, the three dimensions, the judge's reasoning and any change
 * the host made, once published; before that its entrant's alone, locked
 * and unscored (5.2, 5.3).
 */
export default async function EntrySheetPage({ params }: Props) {
  const { slug, entryId } = await params;
  const [user, { t, locale }] = await Promise.all([currentUser(), serverMessages()]);
  const sheet = await entrySheet(decoded(slug), entryId, user?.id);
  if (!sheet) notFound();
  const s = t.competitions.sheet;
  return (
    <FeedColumns title={fill(s.title, { ree: sheet.entry.reeName })} back={`/competitions/${sheet.competition.slug}`}>
      <div className="flex flex-col gap-4 px-[18px] py-4">
        <p className="flex flex-wrap items-center gap-3 text-[12px] text-muted">
          <Link href={`/competitions/${sheet.competition.slug}`} className="text-link">
            {sheet.competition.title}
          </Link>
          {sheet.scored && sheet.entry.rank !== null && <strong className="text-ink">{fill(s.rank, { rank: sheet.entry.rank, total: String(sheet.entry.total ?? 0) })}</strong>}
        </p>
        {!sheet.scored && <p className="text-[12px] text-muted">{s.locked}</p>}
        {sheet.answers.map((answer) => (
          <section key={answer.id} className="card flex flex-col gap-2 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-[13px]">{fill(s.question, { n: answer.ordinal })}</strong>
              {answer.finalScore !== null && <span className="tag">{fill(s.score, { score: String(answer.finalScore) })}</span>}
              {answer.hostScore !== null && answer.aiScore !== null && <span className="tag">{fill(s.ai, { score: String(answer.aiScore) })} → {fill(s.host, { score: String(answer.hostScore) })}</span>}
            </div>
            <p className="text-[13px] font-medium">{answer.question}</p>
            {answer.hidden ? (
              <p className="text-[12px] text-muted">{answer.review === 'rejected' ? s.rejected : s.hidden}</p>
            ) : answer.state === 'answered' ? (
              <CompetitionMarkdown text={answer.text} />
            ) : (
              <p className="text-[12px] text-muted">{answer.state === 'no_answer' ? s.noAnswer : answer.state === 'failed' ? s.failed : s.pending}</p>
            )}
            {!answer.hidden && answer.review === 'rejected' && <p className="text-[12px] text-muted">{s.rejected}</p>}
            {answer.dimensions && <p className="text-[11px] text-muted">{fill(s.dimensions, { accuracy: String(answer.dimensions.accuracy), completeness: String(answer.dimensions.completeness), citation: String(answer.dimensions.citation) })}</p>}
            {answer.rationale && (
              <div className="rounded-[8px] bg-wash p-3 text-[12px]">
                <strong>{s.rationale}</strong>
                <p className="mt-1">{answer.rationale}</p>
              </div>
            )}
            {answer.injection && <p className="text-[12px] text-red">{s.injection}</p>}
            {answer.log.length > 0 && (
              <div className="text-[12px]">
                <strong>{s.log}</strong>
                <ul className="mt-1 flex flex-col gap-1 text-muted">
                  {answer.log.map((entry, index) => (
                    <li key={index}>
                      {fill(s.logLine, { actor: s.actors[entry.actor as 'host' | 'admin'] ?? entry.actor, from: String(entry.from ?? '—'), to: String(entry.to), note: entry.note })} · {formatDateTime(entry.at, locale)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {sheet.scored && answer.postId && !answer.hidden && answer.state === 'answered' && (
              <Link href={`/p/${answer.postId}`} className="text-link">
                {s.viewPost}
              </Link>
            )}
          </section>
        ))}
      </div>
    </FeedColumns>
  );
}
