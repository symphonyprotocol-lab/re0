import type { ReactNode } from 'react';
import type { ReeExample } from '@/lib/domain/ree-examples';
import { HTML_LANG, type Locale } from '@/i18n/locale';
import { localePath } from '@/i18n/paths';
import { Icon } from '@/components/ui/icons';

const MARKER = /(\[\d{1,2}\])/;

/** The summary with its `[n]` markers as superscripts, each titled with the source it cites. */
function withMarkers(summary: string, titles: Map<number, string>): ReactNode[] {
  return summary.replace(/\s+(?=\[\d)/g, '').split(MARKER).map((part, at) => {
    if (!MARKER.test(part)) return part;
    const index = Number(part.slice(1, -1));
    return (
      <sup key={at} className="ml-0.5 font-mono text-[10px] text-blue" title={titles.get(index)}>
        {part}
      </sup>
    );
  });
}

/** The sources the summary cites, in marker order and each title once; the answer's first three when the summary cites none. */
function citedIn(example: ReeExample): { index: number; title: string }[] {
  const shown = new Set([...example.summary.matchAll(/\[(\d{1,2})\]/g)].map((match) => Number(match[1])));
  const pool = shown.size ? example.sources.filter((source) => shown.has(source.index)) : example.sources.slice(0, 3);
  const seen = new Set<string>();
  return pool.filter((source) => source.title && !seen.has(source.title) && seen.add(source.title)).slice(0, 3);
}

/**
 * A public Ree page's "Answered questions" (GSC review 2026-11, 6.8, B8):
 * rendered on the server into the first screen, under the Ree's
 * introduction, so the page's HTML carries real answers. Each question is
 * an h3 under the section's h2 (the Ree's name is the page's one h1), its
 * answer's opening sentences with their citation markers, the sources they
 * cite, and a plain link to the post in this language -- no query string.
 * A Ree with nothing answered shows nothing here.
 */
export function ReeExamples({ examples, locale, labels }: {
  examples: readonly ReeExample[];
  locale: Locale;
  labels: { heading: string; body: string; sources: string; read: string };
}) {
  if (examples.length === 0) return null;
  return (
    <section className="ree-examples mt-6" aria-labelledby="ree-examples-heading">
      <h2 id="ree-examples-heading" className="flex items-center gap-2 text-[14px] font-bold">
        <Icon name="chat" className="size-4 text-blue" />
        {labels.heading}
      </h2>
      <p className="mt-1 text-[12px] text-muted">{labels.body}</p>
      <ol className="mt-3 flex flex-col gap-3">
        {examples.map((example) => {
          const cited = citedIn(example);
          const titles = new Map(example.sources.map((source) => [source.index, source.title]));
          return (
            <li key={example.postId} lang={HTML_LANG[example.lang]} className="rounded-xl border border-line bg-wash px-4 py-3">
              <h3 className="text-[14px] leading-snug font-semibold [overflow-wrap:anywhere]">{example.question}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[#3b4361] [overflow-wrap:anywhere]">{withMarkers(example.summary, titles)}</p>
              {cited.length > 0 && (
                <p className="mt-2 text-[11px] text-muted [overflow-wrap:anywhere]">
                  {labels.sources}:{' '}
                  {cited.map((source, at) => (
                    <span key={source.index}>
                      {at > 0 && ' · '}
                      <span className="font-mono">[{source.index}]</span> {source.title}
                    </span>
                  ))}
                </p>
              )}
              <a href={localePath(locale, `/p/${example.postId}`)} className="mt-2 inline-flex items-center gap-1 text-[12px] text-blue hover:underline" lang={HTML_LANG[locale]}>
                {labels.read}
                <Icon name="arrow" className="size-3" />
              </a>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
