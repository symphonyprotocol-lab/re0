import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { currentUser } from '@/lib/http/session';
import { myCompetitions } from '@/lib/services/competitions';
import { serverMessages } from '@/i18n/server';
import { FeedColumns } from '@/components/shell/feed-columns';
import { CompetitionCards } from '@/components/competitions/competition-cards';
import { Icon } from '@/components/ui/icons';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.competitions.workspace.title };
}

/** `/workspace/competitions`: the competitions I host (to manage) and those my Rees entered. */
export default async function MyCompetitionsPage() {
  const [user, { t, locale }] = await Promise.all([currentUser(), serverMessages()]);
  const mine = await myCompetitions(user!.id);
  const w = t.competitions.workspace;
  return (
    <FeedColumns title={w.title} back="/competitions">
      <div className="flex flex-col gap-6 px-[18px] py-4">
        <div>
          <Link href="/workspace/competitions/new" className="btn btn-sm">
            <Icon name="plus" className="size-3.5" />
            {t.competitions.create}
          </Link>
        </div>
        <section>
          <h2 className="mb-3 text-[15px] font-semibold">{w.hosted}</h2>
          {mine.hosted.length === 0 ? <p className="text-[12px] text-muted">{w.emptyHosted}</p> : <CompetitionCards items={mine.hosted} t={t} locale={locale} hrefOf={(item) => `/workspace/competitions/${item.id}`} />}
        </section>
        <section>
          <h2 className="mb-3 text-[15px] font-semibold">{w.entered}</h2>
          {mine.entered.length === 0 ? (
            <p className="text-[12px] text-muted">{w.emptyEntered}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {mine.entered.map((item) => (
                <li key={item.entryId} className="card flex flex-wrap items-center gap-3 p-3 text-[13px]">
                  <Link href={`/competitions/${item.slug}`} className="font-medium">
                    {item.title}
                  </Link>
                  <span className="tag">{t.competitions.status[item.status]}</span>
                  <span className="text-muted">{item.reeName}</span>
                  <span className="tag">{w.entryStatus[item.entryStatus as keyof typeof w.entryStatus] ?? item.entryStatus}</span>
                  {item.rank !== null && <strong>#{item.rank}</strong>}
                  {(item.entryStatus === 'locked' || item.entryStatus === 'disqualified') && (
                    <Link href={`/competitions/${item.slug}/entries/${item.entryId}`} className="text-link">
                      {t.competitions.page.sheet}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </FeedColumns>
  );
}
