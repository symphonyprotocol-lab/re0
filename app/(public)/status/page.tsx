import type { Metadata } from 'next';
import { unstable_cache } from 'next/cache';
import Link from 'next/link';
import { Card, Chip, SectionHeading } from '@/components/ui/primitives';
import { CircleCheckIcon, ClockIcon } from '@/components/ui/icons';
import { platformStatus, type ComponentStatus } from '@/lib/application/status';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { status } = await getMessages();
  return { title: status.metaTitle, description: status.metaDescription };
}

/**
 * The figures come from the platform's own tables (lib/application/status.ts)
 * and cost a few aggregate queries, so they are computed at most once every
 * few minutes and shared by every visitor. The page itself stays dynamic (the
 * locale is read from the request), which is why the cache sits on the use
 * case rather than on the segment. "Last checked" is when the figures were
 * computed. The cache serialises, so the two dates come back as strings and
 * are rehydrated here.
 */
const REVALIDATE_SECONDS = 300;

const cachedStatus = unstable_cache(() => platformStatus(), ['public-status'], {
  revalidate: REVALIDATE_SECONDS,
});

async function currentStatus() {
  const raw = await cachedStatus();
  return {
    ...raw,
    checkedAt: new Date(raw.checkedAt),
    refresh: {
      ...raw.refresh,
      nextDueAt: raw.refresh.nextDueAt ? new Date(raw.refresh.nextDueAt) : null,
    },
  };
}

/** A basis-point share as a percentage with two decimals. */
function percent(bps: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(bps / 100)}%`;
}

export default async function StatusPage() {
  const [{ locale, t }, status] = await Promise.all([translations(), currentStatus()]);
  const st = t.status;
  const live = st.live;
  const number = new Intl.NumberFormat(locale);
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  const components = status.components.map((component) => ({
    ...component,
    ...live.components[component.id],
  }));
  const degraded = components.filter((component) => component.health === 'degraded');

  const healthChip = (health: ComponentStatus['health']) =>
    health === 'ok' ? (
      <Chip tone="good">{st.healthOk}</Chip>
    ) : health === 'degraded' ? (
      <Chip tone="warn">{st.healthDegraded}</Chip>
    ) : (
      <Chip>{live.healthUnknown}</Chip>
    );

  /* The line under a component's name: what today's rows say, per surface. */
  const todayLine = (component: (typeof components)[number]): string[] => {
    switch (component.id) {
      case 'retrieval':
        return [
          fill(live.todayRequests, { count: number.format(component.today.requests ?? 0) }),
          ...(component.today.p95Ms !== null && component.today.p95Ms !== undefined
            ? [fill(live.p95, { ms: number.format(component.today.p95Ms) })]
            : []),
        ];
      case 'indexing':
        return [
          fill(live.todayOperations, {
            finished: number.format(component.today.finished ?? 0),
            failed: number.format(component.today.failed ?? 0),
          }),
        ];
      case 'refresh':
        return [
          fill(live.refreshScheduled, { count: number.format(status.refresh.scheduled) }),
          ...(status.refresh.overdue > 0
            ? [fill(live.refreshOverdue, { count: number.format(status.refresh.overdue) })]
            : []),
          ...(status.refresh.open > 0
            ? [fill(live.refreshOpen, { count: number.format(status.refresh.open) })]
            : []),
          ...(status.refresh.nextDueAt
            ? [fill(live.nextDue, { when: dateTime.format(status.refresh.nextDueAt) })]
            : []),
        ];
    }
  };

  return (
    <>
      <section className="mx-auto w-full max-w-[1200px] px-5 pt-11 pb-12">
        <SectionHeading eyebrow="STATUS" title={st.title} as="h1" size="lg" />
        <p className="mt-3 max-w-[70ch] text-[13px] leading-[1.7] text-muted">
          {fill(st.lede, { days: status.windowDays })}
        </p>

        <Card className="mt-7 flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className={degraded.length ? 'mt-0.5 text-warn' : 'mt-0.5 text-good'}>
              {degraded.length ? <ClockIcon size={18} /> : <CircleCheckIcon size={18} />}
            </span>
            <div>
              <p className="text-[15px] font-medium text-ink">
                {degraded.length
                  ? fill(st.degradedSummary, { count: degraded.length })
                  : st.allHealthy}
              </p>
              <p className="mt-1 text-[12.5px] leading-[1.7] text-muted">
                {degraded.length
                  ? fill(st.degradedNote, {
                      names: degraded.map((c) => c.name).join(st.nameSeparator),
                    })
                  : st.allHealthyNote}
              </p>
            </div>
          </div>
          <p className="shrink-0 text-[11px] text-faint sm:text-right">
            {st.lastChecked}
            <br className="hidden sm:block" /> {dateTime.format(status.checkedAt)}
          </p>
        </Card>
      </section>

      <section className="mx-auto w-full max-w-[1200px] border-t border-line px-5 pt-12 pb-14">
        <SectionHeading eyebrow="COMPONENTS" title={st.componentsTitle} />
        <p className="mt-3 text-[13px] text-muted">{st.componentsNote}</p>

        <Card className="mt-6 overflow-hidden">
          {components.map((c, index) => (
            <div
              key={c.id}
              className={`flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between ${
                index === 0 ? '' : 'border-t border-line'
              }`}
            >
              <div className="min-w-[240px]">
                <div className="flex items-center gap-2.5">
                  <h3 className="text-[13.5px] font-medium text-ink">
                    {c.name}
                  </h3>
                  {healthChip(c.health)}
                </div>
                <p className="mt-1.5 text-[12px] leading-[1.7] text-muted">{c.detail}</p>
                <p className="mt-1 text-[11px] text-faint">{todayLine(c).join(' · ')}</p>
              </div>

              <div className="flex flex-col items-start gap-2 lg:items-end">
                {c.strip.length > 0 ? (
                  <div aria-hidden className="flex items-end gap-[2px] overflow-hidden">
                    {c.strip.map((day) => (
                      <span
                        key={day.day}
                        title={day.day}
                        className={`h-6 w-[3px] rounded-[1px] ${
                          day.health === 'degraded'
                            ? 'bg-warn'
                            : day.health === 'ok'
                              ? 'bg-good/70'
                              : 'bg-line'
                        }`}
                      />
                    ))}
                  </div>
                ) : null}
                <p className="text-[11px] text-faint">
                  {c.successBps === null ? (
                    live.noTraffic
                  ) : (
                    <>
                      {fill(live.successRate, { days: status.windowDays })}{' '}
                      <span className="font-medium text-muted">
                        {percent(c.successBps, locale)}
                      </span>
                    </>
                  )}
                </p>
              </div>
            </div>
          ))}
        </Card>

        <p className="mt-5 text-[12px] text-faint">{st.uptimeFootnote}</p>
      </section>

      <section className="mx-auto w-full max-w-[1200px] border-t border-line px-5 pt-12 pb-14">
        <SectionHeading eyebrow="INCIDENTS" title={st.incidentsTitle} />
        <p className="mt-3 text-[13px] text-muted">{st.incidentsNote}</p>

        {status.incidents.length === 0 ? (
          <p className="mt-7 border-t border-line py-5 text-[12.5px] text-muted">
            {fill(live.incidentsEmpty, { days: status.windowDays })}
          </p>
        ) : (
          <ol className="mt-7 flex flex-col">
            {status.incidents.map((incident) => (
              <li key={`${incident.component}-${incident.from}`} className="border-t border-line py-5">
                <div className="flex flex-wrap items-center gap-3">
                  <time className="font-mono text-[11px] text-faint">
                    {incident.from === incident.to
                      ? date.format(new Date(incident.from))
                      : `${date.format(new Date(incident.from))} – ${date.format(new Date(incident.to))}`}
                  </time>
                  <h3 className="text-[13.5px] font-medium text-ink">
                    {fill(live.incidentTitle, {
                      component: live.components[incident.component].name,
                    })}
                  </h3>
                  <Chip tone={incident.ongoing ? 'warn' : 'good'}>
                    {incident.ongoing ? st.incidentOngoing : st.incidentResolved}
                  </Chip>
                </div>
                <p className="mt-2 max-w-[80ch] text-[12.5px] leading-[1.75] text-muted">
                  {fill(live.incidentBody, {
                    days: incident.days,
                    peak: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
                      incident.peakFailureBps / 100,
                    ),
                  })}
                </p>
              </li>
            ))}
          </ol>
        )}

        <p className="mt-5 text-[12px] text-faint">{live.derivedNote}</p>
      </section>

      <section className="mx-auto w-full max-w-[1200px] border-t border-line px-5 pt-12 pb-16">
        <SectionHeading eyebrow="REPORT" title={st.reportTitle} />
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Card className="p-6">
            <p className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
              <span className="text-brandink">
                <ClockIcon size={16} />
              </span>
              {st.reportCardTitle}
            </p>
            <p className="mt-2.5 text-[12.5px] leading-[1.75] text-muted">{st.reportCardBody}</p>
            <Link
              href="/contact"
              className="mt-4 inline-block text-[12.5px] font-medium text-brandink hover:underline"
            >
              {st.reportCardLink}
            </Link>
          </Card>
        </div>
      </section>
    </>
  );
}
