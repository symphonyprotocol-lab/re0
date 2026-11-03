import type { Metadata } from 'next';
import Link from 'next/link';
import { CREDIT_USD } from '@/lib/constants';
import { currentUser } from '@/lib/http/session';
import { listRees, reeTotals } from '@/lib/services/rees';
import { dashboardData } from '@/lib/services/statistics';
import { payoutStanding } from '@/lib/services/payouts';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { AttentionPanel, HealthPanel, IncomePanel, RankingPanel } from '@/components/statistics/dashboard-panels';
import { Icon, type IconName } from '@/components/ui/icons';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import './dashboard.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.dashboard.title };
}

function MetricCard({ href, icon, label, value, hint }: { href: string; icon: IconName; label: string; value: string; hint: string }) {
  return (
    <Link href={href} className="card creator-metric">
      <div>
        <span>{label}</span>
        <Icon name={icon} className="" />
      </div>
      <strong>{value}</strong>
      <small>{hint}</small>
    </Link>
  );
}

/**
 * `/dashboard` (prototype workspace.js `page`, styles in ./dashboard.css):
 * four metric cards, my first five Rees with source health and the answer
 * ranking below them, and what needs attention beside the earnings / payout
 * guide. An official account sees three cards and the official notice
 * instead of the payout guide (2.7).
 */
export default async function DashboardPage() {
  const user = (await currentUser())!;
  const { t, locale } = await serverMessages();
  const [totals, top, board, payout] = await Promise.all([
    reeTotals(user.id),
    listRees(user.id, { q: '', visibility: 'all', sort: 'default', size: 12, page: 1 }),
    dashboardData(user.id),
    payoutStanding(user.id),
  ]);
  const d = t.dashboard;
  const n = (value: number) => formatNumber(value, locale);
  const official = user.role === 'official';
  const earned = board.earned;
  const moderated = new Set(board.moderated);
  return (
    <>
      <Topbar crumbs={[{ label: d.title }]} />
      <main className={`creator-overview${official ? ' official-overview' : ''}`}>
        <div className="creator-overview-head">
          <div>
            <p className="eyebrow">{d.eyebrow}</p>
            <h1>{d.title}</h1>
            <p>{d.lede}</p>
          </div>
          <Link href="/rees/new" className="btn">
            <Icon name="plus" className="" />
            {d.create}
          </Link>
        </div>

        <div className="dashboard-section-heading">
          <h2>{d.overview}</h2>
          <span>{d.overviewHint}</span>
        </div>
        <div className="creator-metrics">
          <MetricCard
            href="/rees?visibility=all"
            icon="ree"
            label={d.cards.rees}
            value={n(totals.rees)}
            hint={fill(d.cards.reesHint, { public: n(totals.public), private: n(totals.private) })}
          />
          <MetricCard href="/workspace/sources" icon="file" label={d.cards.sources} value={n(totals.sources)} hint={fill(d.cards.sourcesHint, { ready: n(totals.readySources) })} />
          <MetricCard href="/workspace/answers" icon="chat" label={d.cards.answers} value={n(totals.answers)} hint={d.cards.answersHint} />
          {!official && (
            <MetricCard
              href="/settings?tab=billing&activity=income#credit-activity"
              icon="wallet"
              label={d.cards.earned}
              value={n(earned)}
              hint={fill(d.cards.earnedHint, { usd: (earned * CREDIT_USD).toFixed(2) })}
            />
          )}
        </div>

        <div className="creator-overview-grid">
          <div className="creator-overview-main">
            <section className="card creator-dot-panel">
              <div className="creator-panel-heading">
                <div>
                  <h2>{d.mine}</h2>
                  <p>{d.mineHint}</p>
                </div>
                <Link href="/rees" className="text-link">
                  {d.viewAll}
                  <Icon name="arrow" className="" />
                </Link>
              </div>
              {top.items.length === 0 ? (
                <div className="creator-overview-empty">
                  <Icon name="ree" className="" />
                  <h3>{d.emptyTitle}</h3>
                  <p>{d.emptyBody}</p>
                  <Link href="/rees/new" className="btn">
                    {d.create}
                  </Link>
                </div>
              ) : (
                <div className="creator-dot-list">
                  {top.items.slice(0, 5).map((ree) => {
                    const takenDown = moderated.has(ree.id);
                    const shown = ree.isPublic && !takenDown;
                    return (
                      <article key={ree.id} className="creator-dot-row">
                        <div className="creator-dot-identity">
                          <ReeAvatar avatar={ree.avatarBlob} color={ree.color} />
                          <div>
                            <Link href={`/rees/${ree.id}`}>
                              <strong>{ree.name}</strong>
                            </Link>
                            <span className={`creator-dot-visibility${shown ? ' public' : ''}${takenDown ? ' taken-down' : ''}`}>
                              <Icon name={shown ? 'globe' : 'lock'} className="" />
                              {takenDown ? t.statistics.workspace.takenDown : ree.isPublic ? d.visibility.public : d.visibility.private}
                            </span>
                          </div>
                        </div>
                        <div className="creator-dot-figures">
                          <div>
                            <strong>
                              {n(ree.readySources)}
                              <small> / {n(ree.sources)}</small>
                            </strong>
                            <span>{d.readySources}</span>
                          </div>
                          <div>
                            <strong>{n(ree.answers)}</strong>
                            <span>{d.answers}</span>
                          </div>
                        </div>
                        <div className="creator-dot-actions">
                          <Link href={`/rees/${ree.id}/knowledge`} className="btn-secondary btn-sm">
                            {d.manageKnowledge}
                          </Link>
                          <Link href={`/rees/${ree.id}/video`} className="btn-ghost">
                            <Icon name="film" className="" />
                            {d.video}
                          </Link>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              {totals.rees > 5 && (
                <Link href="/rees" className="text-link creator-overview-more">
                  {fill(d.viewAllCount, { count: n(totals.rees) })}
                  <Icon name="arrow" className="" />
                </Link>
              )}
            </section>
            <HealthPanel t={t} locale={locale} sources={board.sources} />
            <RankingPanel t={t} locale={locale} ranking={board.ranking} reeCount={totals.rees} moderated={moderated} />
          </div>
          <aside className="creator-overview-side">
            <AttentionPanel t={t} locale={locale} rows={board.attention} total={board.attentionTotal} />
            <IncomePanel t={t} locale={locale} earned={earned} official={official} stage={payout.stage} kyc={payout.kyc} held={payout.held} />
          </aside>
        </div>
        <p className="creator-data-note">{d.scopeNote}</p>
        <footer className="page-footer">
          <span>{d.footer.note}</span>
          <span className="mono">{d.footer.tagline}</span>
        </footer>
      </main>
    </>
  );
}
