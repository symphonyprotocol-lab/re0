import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRightIcon, LockKeyholeIcon, ScrollTextIcon } from '@/components/ui/icons';
import { Card, SectionHeading } from '@/components/ui/primitives';
import { LEGAL_EFFECTIVE_AT, inlineMarkup } from '@/components/site/legal-document';
import { getMessages } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { legal } = await getMessages();
  return { title: legal.metaTitle, description: legal.metaDescription };
}

/** Icon and route per document, in the order the dictionary lists them. */
const DOCUMENTS = [
  { key: 'terms', href: '/legal/terms', Icon: ScrollTextIcon },
  { key: 'privacy', href: '/legal/privacy', Icon: LockKeyholeIcon },
] as const;

export default async function LegalPage() {
  const { legal: g } = await getMessages();

  return (
    <div className="mx-auto w-full max-w-[1200px]">
      <section className="px-5 pt-11 pb-12">
        <SectionHeading eyebrow="LEGAL" title={g.title} as="h1" size="lg" />
        <p className="mt-3 max-w-[70ch] text-[13px] leading-[1.7] text-muted">{g.lede}</p>

        <div className="mt-7 grid gap-4 md:grid-cols-2">
          {DOCUMENTS.map(({ key, href, Icon }) => {
            const doc = g.documents[key];
            return (
              <Card key={key} className="flex flex-col p-6">
                <span className="flex size-9 items-center justify-center rounded-lg bg-brandsoft text-brandink">
                  <Icon size={17} />
                </span>
                <h2 className="mt-4 text-[14.5px] font-medium text-ink">{doc.name}</h2>
                <p className="mt-2 text-[12.5px] leading-[1.75] text-muted">{doc.summary}</p>
                <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
                  {doc.covers.map((item) => (
                    <li key={item} className="text-[11.5px] text-faint">
                      {item}
                    </li>
                  ))}
                </ul>
                <p className="mt-5 text-[11.5px] text-faint">
                  {g.effective} <span className="font-mono">{LEGAL_EFFECTIVE_AT}</span>
                </p>
                <Link
                  href={href}
                  className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brandink hover:underline"
                >
                  {g.read}
                  <ArrowRightIcon size={14} />
                </Link>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="border-t border-line px-5 pt-8 pb-16">
        <p className="text-[12.5px] leading-[1.8] text-muted">{inlineMarkup(g.contact)}</p>
        <p className="mt-2 text-[12px] leading-[1.8] text-faint">{g.footnote}</p>
      </section>
    </div>
  );
}
