import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, Chip, SectionHeading } from '@/components/ui/primitives';
import {
  BadgeCheckIcon,
  CircleCheckIcon,
  KeyIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from '@/components/ui/icons';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { contact } = await getMessages();
  return { title: contact.metaTitle, description: contact.metaDescription };
}

/** Icon and address per channel, in the order the dictionary lists them. */
const CHANNEL_ICONS = [KeyIcon, BadgeCheckIcon, SparklesIcon, ShieldCheckIcon];
const CHANNEL_EMAILS = [
  'support@re0.io',
  'claims@re0.io',
  'partners@re0.io',
  'security@re0.io',
];
const ELSEWHERE_HREFS = ['/status', '/pricing', '/legal'];

export default async function ContactPage() {
  const { contact: c } = await getMessages();

  return (
    <>
      <section className="mx-auto w-full max-w-[1080px] px-5 pt-11 pb-12">
        <SectionHeading eyebrow="CONTACT" title={c.title} as="h1" size="lg" />
        <p className="mt-3 max-w-[70ch] text-[13px] leading-[1.7] text-muted">{c.lede}</p>

        <div className="mt-7 grid gap-4 md:grid-cols-2">
          {c.channels.map(({ title, sla, body }, index) => {
            const Icon = CHANNEL_ICONS[index] ?? KeyIcon;
            const email = CHANNEL_EMAILS[index] ?? CHANNEL_EMAILS[0];
            return (
              <Card key={email} className="flex flex-col p-6">
                <div className="flex items-start justify-between gap-4">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-brandsoft text-brandink">
                    <Icon size={17} />
                  </span>
                  <Chip tone="neutral">{sla}</Chip>
                </div>
                <h2 className="mt-4 text-[14.5px] font-medium text-ink">
                  {title}
                </h2>
                <p className="mt-2 text-[12.5px] leading-[1.75] text-muted">{body}</p>
                <a
                  href={`mailto:${email}`}
                  className="mt-4 font-mono text-[12.5px] font-medium text-brandink hover:underline"
                >
                  {email}
                </a>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1080px] border-t border-line px-5 pt-12 pb-14">
        <SectionHeading eyebrow="CHECKLIST" title={c.checklistTitle} />
        <p className="mt-3 text-[13px] text-muted">{c.checklistNote}</p>
        <Card className="mt-6 p-6">
          <ul className="flex flex-col gap-3">
            {c.checklist.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-[12.5px] leading-[1.7] text-muted">
                <span className="mt-0.5 shrink-0 text-good">
                  <CircleCheckIcon size={15} />
                </span>
                {item}
              </li>
            ))}
          </ul>
          <p className="mt-5 border-t border-line pt-4 text-[12px] leading-[1.7] text-faint">
            {c.phishingLead}{' '}
            <a href="mailto:security@re0.io" className="font-medium text-brandink hover:underline">
              security@re0.io
            </a>
            {c.phishingTail}
          </p>
        </Card>
      </section>

      <section className="mx-auto w-full max-w-[1080px] border-t border-line px-5 pt-12 pb-16">
        <SectionHeading eyebrow="ELSEWHERE" title={c.elsewhereTitle} />
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {c.elsewhere.map((item, index) => (
            <Link
              key={item.title}
              href={ELSEWHERE_HREFS[index] ?? '/status'}
              className="rounded-lg border border-line bg-card p-5 transition-colors hover:bg-subtle"
            >
              <p className="text-[13.5px] font-medium text-ink">
                {item.title}
              </p>
              <p className="mt-2 text-[12px] leading-[1.7] text-muted">{item.body}</p>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
