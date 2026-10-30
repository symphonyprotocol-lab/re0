import type { Metadata } from 'next';
import { Button, Card, SectionHeading } from '@/components/ui/primitives';
import {
  BadgeCheckIcon,
  BracesIcon,
  DatabaseIcon,
  SearchIcon,
  ShieldCheckIcon,
} from '@/components/ui/icons';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { about } = await getMessages();
  return { title: about.metaTitle, description: about.metaDescription };
}

/** One icon per principle, in the order the dictionary lists them. */
const PRINCIPLE_ICONS = [ShieldCheckIcon, BracesIcon, BadgeCheckIcon, SearchIcon];

export default async function AboutPage() {
  const { about: a } = await getMessages();

  return (
    <>
      <section>
        <div className="mx-auto w-full max-w-[1200px] px-5 pt-11 pb-14">
          <SectionHeading eyebrow="ABOUT" title={a.title} as="h1" size="lg" />
          <p className="mt-4 max-w-[70ch] text-[15px] leading-[1.75] text-muted">
            {a.lede}
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-2.5">
            <Button href="/channels" size="md">
              {a.browse}
            </Button>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1200px] border-t border-line px-5 pt-12 pb-14">
        <SectionHeading eyebrow="WHY" title={a.whyTitle} />
        <div className="mt-7 flex flex-col">
          {a.problems.map((item) => (
            <div key={item.title} className="border-t border-line py-5">
              <h3 className="text-[15px] font-medium text-ink">
                {item.title}
              </h3>
              <p className="mt-2 max-w-[80ch] text-[13px] leading-[1.75] text-muted">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1200px] border-t border-line px-5 pt-12 pb-14">
        <SectionHeading eyebrow="PRINCIPLES" title={a.principlesTitle} />
        <div className="mt-7 grid gap-4 md:grid-cols-2">
          {a.principles.map(({ title, body }, index) => {
            const Icon = PRINCIPLE_ICONS[index] ?? ShieldCheckIcon;
            return (
              <Card key={title} className="p-6">
                <span className="flex size-9 items-center justify-center rounded-lg bg-brandsoft text-brandink">
                  <Icon size={17} />
                </span>
                <h3 className="mt-4 text-[14.5px] font-medium text-ink">
                  {title}
                </h3>
                <p className="mt-2 text-[12.5px] leading-[1.75] text-muted">{body}</p>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1200px] border-t border-line px-5 pt-12 pb-14">
        <SectionHeading eyebrow="SCOPE" title={a.scopeTitle} />
        <p className="mt-3 text-[13px] text-muted">{a.scopeNote}</p>
        <div className="mt-7 grid gap-x-10 gap-y-6 sm:grid-cols-2">
          {a.scope.map((item) => (
            <div key={item.title} className="border-t border-line pt-4">
              <p className="text-[10px] font-medium tracking-[0.1em] text-brandink">{item.kicker}</p>
              <h3 className="mt-1.5 text-[13.5px] font-medium text-ink">
                {item.title}
              </h3>
              <p className="mt-2 text-[12.5px] leading-[1.75] text-muted">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1200px] border-t border-line px-5 pt-12 pb-16">
        <Card className="flex flex-col items-start gap-5 p-7 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3.5">
            <span className="mt-0.5 text-brandink">
              <DatabaseIcon size={18} />
            </span>
            <div>
              <h2 className="text-[17px] font-medium text-ink">
                {a.contactTitle}
              </h2>
              <p className="mt-2 max-w-[60ch] text-[12.5px] leading-[1.75] text-muted">
                {a.contactBody}
              </p>
            </div>
          </div>
          <Button href="/contact" size="md" className="shrink-0">
            {a.contactCta}
          </Button>
        </Card>
      </section>
    </>
  );
}
