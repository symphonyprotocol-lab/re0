import type { Metadata } from 'next';
import Link from 'next/link';
import { CREDIT_USD } from '@/lib/constants';
import { currentUser } from '@/lib/http/session';
import { listRees, reeTotals } from '@/lib/services/rees';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { Icon, type IconName } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.dashboard.title };
}

function MetricCard({ href, icon, label, value, hint }: { href: string; icon: IconName; label: string; value: string; hint: string }) {
  return (
    <Link href={href} className="card group flex flex-col gap-3 p-5 transition hover:border-[#c4cce0] hover:shadow-sm">
      <span className="flex items-center justify-between text-[12px] font-semibold text-muted">
        {label}
        <Icon name={icon} className="size-4 text-[#a3a9bb] group-hover:text-blue" />
      </span>
      <strong className="font-mono text-[28px] leading-none font-semibold">{value}</strong>
      <span className="flex items-center gap-1 text-[11px] text-muted">
        {hint}
        <Icon name="arrow" className="size-3" />
      </span>
    </Link>
  );
}

function Later({ title }: { title: string }) {
  return (
    <section className="card p-5">
      <h2 className="text-[15px] font-bold">{title}</h2>
      <LaterBody />
    </section>
  );
}

async function LaterBody() {
  const { t } = await serverMessages();
  return (
    <div className="mt-4 flex flex-col items-center gap-2 rounded-lg border border-dashed border-line bg-wash px-4 py-8 text-center">
      <Icon name="clock" className="size-5 text-[#a3a9bb]" />
      <strong className="text-[12px]">{t.dashboard.later}</strong>
      <p className="text-[11px] text-muted">{t.dashboard.laterBody}</p>
    </div>
  );
}

/** `/dashboard`: four metric cards and my first five Rees; the other panels arrive in step 5. */
export default async function DashboardPage() {
  const user = (await currentUser())!;
  const { t, locale } = await serverMessages();
  const [totals, top] = await Promise.all([
    reeTotals(user.id),
    listRees(user.id, { q: '', visibility: 'all', sort: 'default', size: 12, page: 1 }),
  ]);
  const n = (value: number) => formatNumber(value, locale);
  const earned = 0;
  return (
    <>
      <Topbar crumbs={[{ label: t.dashboard.title }]} />
      <main className="mx-auto max-w-[1180px] px-4 py-8 md:px-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">{t.dashboard.eyebrow}</p>
            <h1 className="mt-2 text-[28px] font-extrabold tracking-tight">{t.dashboard.title}</h1>
            <p className="mt-2 text-[13px] text-muted">{t.dashboard.lede}</p>
          </div>
          <Link href="/rees/new" className="btn">
            <Icon name="plus" />
            {t.dashboard.create}
          </Link>
        </div>

        <div className="mt-8 flex items-baseline justify-between gap-4">
          <h2 className="text-[15px] font-bold">{t.dashboard.overview}</h2>
          <span className="hidden text-[11px] text-muted sm:inline">{t.dashboard.overviewHint}</span>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            href="/rees?visibility=all"
            icon="ree"
            label={t.dashboard.cards.rees}
            value={n(totals.rees)}
            hint={fill(t.dashboard.cards.reesHint, { public: n(totals.public), private: n(totals.private) })}
          />
          <MetricCard
            href="/rees"
            icon="file"
            label={t.dashboard.cards.sources}
            value={n(totals.sources)}
            hint={fill(t.dashboard.cards.sourcesHint, { ready: n(totals.readySources) })}
          />
          <MetricCard href="/rees?sort=answers&order=desc" icon="chat" label={t.dashboard.cards.answers} value={n(totals.answers)} hint={t.dashboard.cards.answersHint} />
          <MetricCard
            href="/settings?tab=billing"
            icon="layers"
            label={t.dashboard.cards.earned}
            value={n(earned)}
            hint={fill(t.dashboard.cards.earnedHint, { usd: (earned * CREDIT_USD).toFixed(2) })}
          />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section className="card p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-[15px] font-bold">{t.dashboard.mine}</h2>
                <p className="mt-1 text-[11px] text-muted">{t.dashboard.mineHint}</p>
              </div>
              <Link href="/rees" className="text-link text-[12px]">
                {t.dashboard.viewAll}
                <Icon name="arrow" className="size-3.5" />
              </Link>
            </div>
            {top.items.length === 0 ? (
              <div className="mt-5 flex flex-col items-center gap-3 rounded-xl border border-dashed border-line bg-wash px-4 py-10 text-center">
                <ReeAvatar size="lg" />
                <strong className="text-[14px]">{t.dashboard.emptyTitle}</strong>
                <p className="max-w-[360px] text-[12px] text-muted">{t.dashboard.emptyBody}</p>
                <Link href="/rees/new" className="btn btn-sm">
                  <Icon name="plus" />
                  {t.dashboard.create}
                </Link>
              </div>
            ) : (
              <ul className="mt-4 divide-y divide-line">
                {top.items.slice(0, 5).map((ree) => (
                  <li key={ree.id} className="flex flex-wrap items-center gap-3 py-4">
                    <ReeAvatar avatar={ree.avatarBlob} color={ree.color} />
                    <div className="min-w-0 flex-1">
                      <Link href={`/rees/${ree.id}/settings`} className="block truncate text-[14px] font-semibold hover:text-blue">
                        {ree.name}
                      </Link>
                      <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                        <Icon name={ree.isPublic ? 'globe' : 'lock'} className="size-3" />
                        {ree.isPublic ? t.common.visibility.public : t.common.visibility.private}
                      </span>
                    </div>
                    <div className="flex gap-6 text-right">
                      <div>
                        <strong className="font-mono text-[15px]">
                          {n(ree.readySources)} / {n(ree.sources)}
                        </strong>
                        <p className="text-[10px] text-muted">{t.dashboard.readySources}</p>
                      </div>
                      <div>
                        <strong className="font-mono text-[15px]">{n(ree.answers)}</strong>
                        <p className="text-[10px] text-muted">{t.dashboard.answers}</p>
                      </div>
                    </div>
                    <div className="flex w-full justify-end gap-2 sm:w-auto">
                      <Link href={`/rees/${ree.id}/knowledge`} className="btn-secondary btn-sm">
                        {t.dashboard.manageKnowledge}
                      </Link>
                      <Link href={`/rees/${ree.id}/chat`} className="btn-secondary btn-sm">
                        <Icon name="chat" className="size-3.5" />
                        {t.dashboard.testChat}
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {totals.rees > 5 && (
              <Link href="/rees" className="mt-2 block text-center text-[12px] font-semibold text-blue hover:underline">
                {fill(t.dashboard.viewAllCount, { count: n(totals.rees) })}
              </Link>
            )}
          </section>
          <Later title={t.dashboard.todo} />
        </div>
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <Later title={t.dashboard.sourceHealth} />
          <Later title={t.dashboard.ranking} />
          <Later title={t.dashboard.payouts} />
        </div>
      </main>
    </>
  );
}
