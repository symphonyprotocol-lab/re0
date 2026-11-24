import type { Metadata } from 'next';
import { currentUser } from '@/lib/http/session';
import { COMPETITION_ENTRIES_MAX, COMPETITION_ENTRIES_MAX_NORMAL, COMPETITION_HOST_MIN_AGE_DAYS, COMPETITION_HOST_PUBLIC_REES, COMPETITION_REVIEW_HOURS_DEFAULT, DEFAULT_WEIGHTS, entriesMaxFor } from '@/lib/domain/competition';
import { serverMessages } from '@/i18n/server';
import { fill } from '@/i18n/format';
import { FeedColumns } from '@/components/shell/feed-columns';
import { CompetitionEditor } from '@/components/competitions/editor';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.competitions.editor.newTitle };
}

/** `/workspace/competitions/new`: 建草稿 (docs/design/competitions.md 5.1 step 1); the questions come once it is saved. */
export default async function NewCompetitionPage() {
  const [user, { t, locale }] = await Promise.all([currentUser(), serverMessages()]);
  const c = t.competitions.editor;
  const entriesMax = entriesMaxFor(user!.role);
  return (
    <FeedColumns title={c.newTitle} back="/workspace/competitions">
      <div className="flex flex-col gap-4 px-[18px] py-4">
        <p className="text-[12px] text-muted">{fill(c.hostRules, { days: COMPETITION_HOST_MIN_AGE_DAYS, rees: COMPETITION_HOST_PUBLIC_REES, normal: COMPETITION_ENTRIES_MAX_NORMAL, max: COMPETITION_ENTRIES_MAX })}</p>
        <CompetitionEditor
          settings={{ title: '', channel: '', description: '', lang: locale, questionMode: 'open', payer: 'entrant', maxEntries: entriesMax, maxEntriesPerUser: 1, weights: DEFAULT_WEIGHTS, revealReference: true, deadlineAt: '', reviewHours: COMPETITION_REVIEW_HOURS_DEFAULT }}
          questions={[]}
          entriesMax={entriesMax}
        />
      </div>
    </FeedColumns>
  );
}
