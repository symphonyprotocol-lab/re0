import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { ContentPage } from '@/components/site/content-page';

/** A legal page in the shell's wide column (v6): the title is the column head's h1; then the lede, a table of contents and numbered sections. Blank lines in a body start new paragraphs. */
export function LegalDocument({
  eyebrow,
  title,
  lede,
  updated,
  contentsLabel,
  sections,
  footnote,
  other,
}: {
  eyebrow: string;
  title: string;
  lede: string;
  updated: string;
  contentsLabel: string;
  sections: { id: string; title: string; body: string }[];
  footnote: string;
  other: { href: string; label: string };
}) {
  return (
    <ContentPage title={title}>
      <article className="xp-legal">
        <p className="eyebrow">{eyebrow}</p>
        <p className="xpage-lede mt-2 max-w-[720px]">{lede}</p>
        <p className="mt-2 text-[12px] text-muted">{updated}</p>
        <div className="mt-6 grid gap-8 lg:grid-cols-[200px_minmax(0,1fr)]">
          <nav aria-label={contentsLabel} className="lg:sticky lg:top-24 lg:self-start">
            <p className="text-[12px] font-semibold">{contentsLabel}</p>
            <ol className="mt-3 flex flex-col gap-2 text-[12px] text-muted">
              {sections.map((section, index) => (
                <li key={section.id}>
                  <a href={`#${section.id}`} className="hover:text-blue">
                    {index + 1}. {section.title}
                  </a>
                </li>
              ))}
            </ol>
            <Link href={other.href} className="text-link mt-5 text-[12px]">
              {other.label}
            </Link>
          </nav>
          <div className="min-w-0">
            {/* Sections are separated by space, not lines (v6). */}
            {sections.map((section, index) => (
              <section key={section.id} id={section.id} className="scroll-mt-24 pb-8">
                <h2 className="text-[16px] font-bold">
                  <span className="mr-2 font-mono text-[12px] text-muted">{String(index + 1).padStart(2, '0')}</span>
                  {section.title}
                </h2>
                {section.body.split('\n\n').map((paragraph) => (
                  <p key={paragraph.slice(0, 40)} className="mt-3 text-[13px] leading-[1.8] text-[#3b4361]">
                    {paragraph}
                  </p>
                ))}
              </section>
            ))}
            <p className="rounded-xl bg-wash px-4 py-3 text-[12px] text-muted">{footnote}</p>
          </div>
        </div>
      </article>
    </ContentPage>
  );
}
