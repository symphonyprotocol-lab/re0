import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ScenarioDemo } from '@/components/site/scenario-demo';
import { Button, Card, Chip, SectionHeading } from '@/components/ui/primitives';
import { ArrowRightIcon, CircleCheckIcon } from '@/components/ui/icons';
import { isPromoted, isScenario, scenarioPath, SCENARIOS } from '@/lib/domain/scenarios';
import { getMessages } from '@/lib/i18n/server';

type Params = { params: Promise<{ scenario: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { scenario } = await params;
  if (!isScenario(scenario)) return {};
  const { scenarios } = await getMessages();
  return {
    title: scenarios[scenario].metaTitle,
    description: scenarios[scenario].metaDescription,
    alternates: { canonical: scenarioPath(scenario) },
  };
}

/**
 * One scenario of agent-first-proposal.md 2.2: its assets, what the Agent
 * does with them, the outlets it uses, and a demo conversation that is
 * fixed copy -- no model is called (4.2). Creators' call to action is 开通
 * 频道. Life is reachable but marked as not promoted yet.
 */
export default async function ScenarioPage({ params }: Params) {
  const { scenario } = await params;
  if (!isScenario(scenario)) notFound();
  const { scenarios: s } = await getMessages();
  const page = s[scenario];
  const lists = [
    { title: s.assetsTitle, items: page.assets },
    { title: s.agentTitle, items: page.agent },
    { title: s.outletsTitle, items: page.outlets },
  ];

  return (
    <>
      <section>
        <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 gap-10 px-5 pt-14 pb-14 lg:grid-cols-[minmax(0,1fr)_440px]">
          <div className="flex flex-col items-start">
            <div className="flex flex-wrap items-center gap-2">
              <p className="eyebrow">
                {s.eyebrow} · {s.names[scenario]}
              </p>
              {isPromoted(scenario) ? null : <Chip>{s.notPromoted}</Chip>}
            </div>
            <h1 className="mt-4 max-w-[22ch] text-[32px] leading-[1.3] font-semibold tracking-[0.018em] text-ink sm:text-[40px]">
              {page.title}
            </h1>
            <p className="mt-4 max-w-[60ch] text-[15px] leading-[1.75] text-muted">{page.lede}</p>
            {isPromoted(scenario) ? null : <p className="mt-3 max-w-[60ch] text-[12.5px] text-faint">{s.notPromotedNote}</p>}
            <div className="mt-7">
              <Button href={page.ctaHref} size="md">
                {page.cta}
                <ArrowRightIcon size={15} />
              </Button>
            </div>
          </div>
          <ScenarioDemo turns={page.demo} labels={s} />
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1200px] border-t border-line px-5 pt-12 pb-14">
        <div className="grid gap-4 md:grid-cols-3">
          {lists.map((list) => (
            <Card key={list.title} className="p-5">
              <h2 className="text-[14px] font-medium text-ink">{list.title}</h2>
              <ul className="mt-3 flex flex-col gap-2 text-[12.5px] leading-[1.6] text-muted">
                {list.items.map((item) => (
                  <li key={item} className="flex items-start gap-2">
                    <CircleCheckIcon size={14} className="mt-[3px] shrink-0 text-brandink" />
                    {item}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1200px] border-t border-line px-5 pt-10 pb-16">
        <SectionHeading eyebrow={s.eyebrow} title={s.otherScenarios} />
        <ul className="mt-5 flex flex-wrap gap-3">
          {SCENARIOS.filter((other) => other !== scenario).map((other) => (
            <li key={other}>
              <Link
                href={scenarioPath(other)}
                className="flex h-10 items-center gap-2 rounded-full border border-line px-4 text-caption text-ink transition-colors hover:bg-subtle"
              >
                {s.names[other]}
                <ArrowRightIcon size={14} />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
