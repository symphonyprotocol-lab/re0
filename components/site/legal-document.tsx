import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronLeftIcon } from '@/components/ui/icons';
import { Card, SectionHeading } from '@/components/ui/primitives';

/**
 * The date both legal documents carry.
 *
 * One constant rather than one per document: the terms and the privacy notice
 * are published together, and a reader comparing the two should never have to
 * work out which of two dates the other page was written against.
 */
export const LEGAL_EFFECTIVE_AT = '2026-10-01';

export type LegalSection = {
  /** Anchor id, supplied by the page so the copy stays free of routing. */
  id: string;
  title: string;
  hint: string;
  clauses: string[];
};

/*
 * The two pieces of inline markup the clauses need: `code` for the file and
 * field names the product prints verbatim, and a bare email address for the
 * contact routes. Both are written into the dictionary as plain text, so a
 * clause stays one translatable string instead of a lead/middle/tail trio that
 * a translator has to reassemble in their head.
 */
const INLINE = /`([^`]+)`|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;

export function inlineMarkup(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > cursor) out.push(text.slice(cursor, at));
    const [whole, code, email] = match;
    out.push(
      code ? (
        <code
          key={`${at}`}
          className="rounded bg-mutedbg px-1 py-0.5 font-mono text-[11.5px] text-steel"
        >
          {code}
        </code>
      ) : (
        <a
          key={`${at}`}
          href={`mailto:${email}`}
          className="font-medium text-brandink hover:underline"
        >
          {email}
        </a>
      ),
    );
    cursor = at + whole.length;
  }

  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

function Article({ id, n, title, clauses }: { id: string; n: number; title: string; clauses: string[] }) {
  return (
    <section id={id} className="scroll-mt-[78px] border-t border-line px-5 pt-11 pb-3 last:pb-14">
      <h2 className="text-[21px] leading-[1.3] font-medium text-ink">
        {n}. {title}
      </h2>
      <div className="mt-4 flex max-w-[80ch] flex-col gap-3.5 text-[13px] leading-[1.8] text-muted">
        {clauses.map((clause, i) => (
          <p key={clause.slice(0, 32)} className="flex gap-3">
            <span className="shrink-0 font-mono text-[11.5px] leading-[1.95] text-faint">
              {n}.{i + 1}
            </span>
            <span>{inlineMarkup(clause)}</span>
          </p>
        ))}
      </div>
    </section>
  );
}

/**
 * One legal document: lede, table of contents, numbered articles.
 *
 * Numbering is positional -- the heading, the table of contents entry and the
 * clause marks all come from the section's place in the array -- so an article
 * removed from the dictionary closes the numbering up rather than leaving a
 * hole a reader would take for a clause that went missing.
 */
export function LegalDocument({
  eyebrow,
  title,
  ledeLead,
  ledeTail,
  contents,
  sections,
  back,
  also,
  footnote,
}: {
  eyebrow: string;
  title: string;
  ledeLead: string;
  ledeTail: string;
  contents: string;
  sections: LegalSection[];
  back: string;
  /** Pointer to the sibling document, so neither is read in isolation. */
  also: { lead: string; label: string; href: string };
  footnote: string;
}) {
  return (
    <div className="mx-auto w-full max-w-[1200px]">
      <section className="px-5 pt-11 pb-12">
        <Link
          href="/legal"
          className="inline-flex items-center gap-1 text-[12px] text-muted transition-colors hover:text-ink"
        >
          <ChevronLeftIcon size={14} />
          {back}
        </Link>

        <div className="mt-5">
          <SectionHeading eyebrow={eyebrow} title={title} as="h1" size="lg" />
        </div>
        <p className="mt-3 max-w-[70ch] text-[13px] leading-[1.7] text-muted">
          {ledeLead} <span className="font-medium text-ink">{LEGAL_EFFECTIVE_AT}</span>
          {ledeTail}
        </p>

        <Card className="mt-7 p-6">
          <p className="text-[11px] font-medium tracking-[0.1em] text-brandink">{contents}</p>
          <ul className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {sections.map((section, i) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="group flex items-baseline gap-3">
                  <span className="font-mono text-[11px] text-faint">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span>
                    <span className="text-[13px] font-medium text-ink group-hover:text-brandink">
                      {section.title}
                    </span>
                    <span className="ml-2 text-[11.5px] text-faint">{section.hint}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {sections.map((section, i) => (
        <Article
          key={section.id}
          id={section.id}
          n={i + 1}
          title={section.title}
          clauses={section.clauses}
        />
      ))}

      <section className="border-t border-line px-5 pt-8 pb-16">
        <p className="text-[12px] leading-[1.8] text-faint">
          {also.lead}{' '}
          <Link href={also.href} className="font-medium text-brandink hover:underline">
            {also.label}
          </Link>
        </p>
        <p className="mt-2 text-[12px] leading-[1.8] text-faint">{footnote}</p>
      </section>
    </div>
  );
}
