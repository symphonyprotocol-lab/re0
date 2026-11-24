import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { channelHref } from '@/lib/domain/hashtags';
import { enterableRees, getCompetition } from '@/lib/services/competitions';
import { PRIVATE_ROBOTS, UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { FeedColumns } from '@/components/shell/feed-columns';
import { CompetitionMarkdown } from '@/components/competitions/competition-markdown';
import { EnterPanel, ReportCompetition } from '@/components/competitions/enter-panel';

type Props = { params: Promise<{ slug: string }> };

const slugOf = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
};

/** Only a published competition, not hidden, is indexed (docs/design/competitions.md 13.2); a host's draft never. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ slug }, user] = await Promise.all([params, currentUser()]);
  const page = await getCompetition(slugOf(slug), user?.id);
  if (!page) return { robots: PRIVATE_ROBOTS };
  const description = page.description.replace(/\s+/g, ' ').slice(0, 160);
  return { title: page.title, description, robots: page.status === 'published' && !page.hidden ? undefined : page.status === 'draft' || page.status === 'pending' || page.status === 'rejected' ? PRIVATE_ROBOTS : UNLISTED_ROBOTS };
}

/**
 * `/competitions/[slug]`: a competition as this viewer may read it -- the
 * rules, scoring and fees, the questions once public, the entries and the
 * way to enter while open, progress while running, and the leaderboard
 * with each Ree's answers once published (5.3).
 */
export default async function CompetitionPage({ params }: Props) {
  const { slug } = await params;
  const [user, { t, locale }] = await Promise.all([currentUser(), serverMessages()]);
  const page = await getCompetition(slugOf(slug), user?.id);
  if (!page) notFound();
  const c = t.competitions;
  const p = c.page;
  const open = page.status === 'open' && Boolean(page.deadlineAt && new Date(page.deadlineAt).getTime() > Date.now());
  const rees = user && open && !page.isHost ? await enterableRees(user.id, page.id) : [];
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  /* Entering and the scoring rules sit in the page itself, not the right column, which narrow screens drop. */
  const enter = (
    <section className="card flex flex-col gap-3 p-4">
      <h2 className="text-[15px] font-semibold">{c.enter.title}</h2>
      <EnterPanel
        competitionId={page.id}
        signedIn={Boolean(user)}
        loginHref={`/login?returnTo=${encodeURIComponent(`/competitions/${page.slug}`)}`}
        isHost={page.isHost}
        open={open}
        questions={page.questions}
        fee={page.answerFee}
        hostPays={page.payer === 'host'}
        openBook={page.questionMode === 'open'}
        rees={rees}
        mine={page.entryList.filter((entry) => entry.mine && entry.status === 'entered').map((entry) => ({ id: entry.id, reeName: entry.reeName }))}
      />
      {page.isHost && (
        <Link href={`/workspace/competitions/${page.id}`} className="btn-secondary btn-sm self-start">
          {p.manage}
        </Link>
      )}
    </section>
  );
  const scoring = (
    <section>
      <h2 className="mb-2 text-[15px] font-semibold">{p.scoring}</h2>
      <p className="text-[13px]">{fill(p.weights, { accuracy: percent(page.weights.accuracy), completeness: percent(page.weights.completeness), citation: percent(page.weights.citation) })}</p>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">{p.scoringNote}</p>
      <p className="mt-2 text-[12px] text-muted">
        {page.revealReference ? p.revealYes : p.revealNo} {fill(p.fees, { answer: formatNumber(page.answerFee, locale), payer: c.payer[page.payer] })}
      </p>
    </section>
  );
  return (
    <FeedColumns title={page.title} back="/competitions">
      <div className="flex flex-col gap-5 px-[18px] py-4">
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="tag">{c.status[page.status]}</span>
          <span className="tag">{c.mode[page.questionMode]}</span>
          {page.deadlineAt && <span className="text-muted">{fill(c.card.deadline, { at: formatDateTime(page.deadlineAt, locale) })}</span>}
          <span className="text-muted">{fill(c.card.entries, { n: formatNumber(page.entries, locale), max: formatNumber(page.maxEntries, locale) })}</span>
          <span className="text-muted">{fill(c.host, { name: page.hostName ?? c.hostSomeone })}</span>
          {page.channel && (
            <Link href={channelHref(page.channel)} className="text-link">
              {fill(p.channel, { name: page.channel })}
            </Link>
          )}
        </div>
        {page.status === 'cancelled' && <p className="info-strip text-[13px]">{p.cancelled}</p>}
        {page.hidden && <p className="info-strip text-[13px]">{p.hidden}</p>}
        {page.description && (
          <section>
            <h2 className="mb-2 text-[15px] font-semibold">{p.rules}</h2>
            <CompetitionMarkdown text={page.description} />
          </section>
        )}
        {page.status === 'open' && enter}
        {page.status !== 'open' && page.isHost && (
          <Link href={`/workspace/competitions/${page.id}`} className="btn-secondary btn-sm self-start">
            {p.manage}
          </Link>
        )}
        {page.status !== 'cancelled' && scoring}
        {page.progress && (
          <section className="card p-4">
            <p className="text-[13px] font-medium">{fill(p.progress, { answered: formatNumber(page.progress.answered, locale), judged: formatNumber(page.progress.judged, locale), total: formatNumber(page.progress.total, locale) })}</p>
            <p className="mt-1 text-[12px] text-muted">{p.progressNote}</p>
            {page.status === 'review' && page.reviewEndsAt && <p className="mt-1 text-[12px] text-muted">{fill(p.reviewUntil, { at: formatDateTime(page.reviewEndsAt, locale) })}</p>}
          </section>
        )}
        {page.leaderboard && (
          <section>
            <h2 className="mb-2 text-[15px] font-semibold">{p.leaderboard}</h2>
            <div className="card overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] text-muted">
                    <th className="px-3 py-2">{p.rank}</th>
                    <th className="px-3 py-2">{p.ree}</th>
                    <th className="px-3 py-2">{p.total}</th>
                    <th className="px-3 py-2">{p.answered}</th>
                    {(page.questionList ?? []).map((item) => (
                      <th key={item.id} className="px-3 py-2">
                        Q{item.ordinal}
                      </th>
                    ))}
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {page.leaderboard.map((row) => (
                    <tr key={row.entryId} className="border-t border-line">
                      <td className="px-3 py-2 font-semibold">{row.disqualified ? '—' : row.rank}</td>
                      <td className="px-3 py-2">
                        {row.reeName}
                        {row.disqualified && <span className="tag ml-2">{p.disqualified}</span>}
                      </td>
                      <td className="px-3 py-2">{row.total ?? '—'}</td>
                      <td className="px-3 py-2">{row.answered}</td>
                      {row.scores.map((score) => (
                        <td key={score.ordinal} className="px-3 py-2" title={score.overridden ? p.overridden : undefined}>
                          {score.score}
                          {score.overridden ? '*' : ''}
                        </td>
                      ))}
                      <td className="px-3 py-2">
                        <Link href={`/competitions/${page.slug}/entries/${row.entryId}`} className="text-link">
                          {p.sheet}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {page.answerModel && <p className="mt-2 text-[11px] text-muted">{fill(p.models, { answer: page.answerModel, judge: page.judgeModel ?? '—' })}</p>}
          </section>
        )}
        <section>
          <h2 className="mb-2 text-[15px] font-semibold">{p.questions}</h2>
          {page.questionList ? (
            <ol className="flex flex-col gap-3">
              {page.questionList.map((item) => (
                <li key={item.id} className="card p-4">
                  <p className="text-[13px] font-medium">
                    {item.ordinal}. {item.question}
                  </p>
                  {item.detail && <p className="mt-1 whitespace-pre-wrap text-[12px] text-muted">{item.detail}</p>}
                  <p className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted">
                    <span>{fill(p.questionWeight, { weight: String(item.weight) })}</span>
                    {item.postId && (
                      <Link href={`/p/${item.postId}`} className="text-link">
                        {p.viewPost}
                      </Link>
                    )}
                  </p>
                  {item.referenceAnswer && (
                    <div className="mt-2 rounded-[8px] bg-wash p-3 text-[12px]">
                      <strong>{p.reference}</strong>
                      <p className="mt-1 whitespace-pre-wrap">{item.referenceAnswer}</p>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-[12px] text-muted">{p.questionsHidden}</p>
          )}
        </section>
        {!page.leaderboard && page.status !== 'cancelled' && (
          <section>
            <h2 className="mb-2 text-[15px] font-semibold">{p.entries}</h2>
            {page.entryList.length === 0 ? (
              <p className="text-[12px] text-muted">{p.entriesEmpty}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {page.entryList.map((entry) => (
                  <li key={entry.id} className="tag">
                    {entry.reeName}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {!page.isHost && page.status !== 'cancelled' && (
          <div>
            <ReportCompetition competitionId={page.id} />
          </div>
        )}
      </div>
    </FeedColumns>
  );
}
