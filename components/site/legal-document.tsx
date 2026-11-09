import { WorkspaceLink as Link } from '@/components/shell/workspace-link';

/** A legal page: title, lede, a table of contents and numbered sections; blank lines in a body start new paragraphs. */
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
    <article className="mx-auto max-w-[1100px] px-4 py-12 sm:px-6 lg:py-16">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="mt-3 text-[34px] leading-tight font-extrabold sm:text-[42px]">{title}</h1>
      <p className="mt-4 max-w-[720px] text-[15px] leading-relaxed text-muted">{lede}</p>
      <p className="mt-3 text-[12px] text-muted">{updated}</p>
      <div className="mt-10 grid gap-10 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label={contentsLabel} className="lg:sticky lg:top-24 lg:self-start">
          <p className="text-[12px] font-semibold">{contentsLabel}</p>
          <ol className="mt-3 flex flex-col gap-2 text-[13px] text-muted">
            {sections.map((section, index) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="hover:text-blue">
                  {index + 1}. {section.title}
                </a>
              </li>
            ))}
          </ol>
          <Link href={other.href} className="text-link mt-6 text-[13px]">
            {other.label}
          </Link>
        </nav>
        <div className="min-w-0">
          {sections.map((section, index) => (
            <section key={section.id} id={section.id} className="scroll-mt-24 border-b border-line py-7 first:pt-0 last:border-0">
              <h2 className="text-[18px] font-bold">
                <span className="mr-2 font-mono text-[13px] text-muted">{String(index + 1).padStart(2, '0')}</span>
                {section.title}
              </h2>
              {section.body.split('\n\n').map((paragraph) => (
                <p key={paragraph.slice(0, 40)} className="mt-3 text-[14px] leading-[1.8] text-[#3b4361]">
                  {paragraph}
                </p>
              ))}
            </section>
          ))}
          <p className="mt-8 rounded-xl bg-wash px-4 py-3 text-[12px] text-muted">{footnote}</p>
        </div>
      </div>
    </article>
  );
}
