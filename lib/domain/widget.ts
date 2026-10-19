/**
 * What the website widget shows a visitor, as pure functions.
 * requirement.md 9.4.
 */

/**
 * A page the answer can open, with every retrieved passage of it.
 *
 * The visitor is shown pages, not passages: a pricing page that contributed
 * six chunks is one card, and a sentence citing two of its chunks carries one
 * footnote. The section is kept only when the page's passages agree on it;
 * otherwise it would name one section for a card that stands for several.
 */
export interface WidgetSource {
  url: string;
  title: string;
  section: string | null;
  /** Every retrieved chunk of this page, in retrieval order. */
  chunkIds: string[];
}

/** Collapse retrieved chunks to pages, in the order each page first appeared. */
export function pagesOf(
  chunks: readonly {
    chunkId: string;
    citation: { sourceUrl: string; documentTitle: string; section?: string | null };
  }[],
): WidgetSource[] {
  const pages = new Map<string, WidgetSource>();
  for (const chunk of chunks) {
    const section = chunk.citation.section ?? null;
    const page = pages.get(chunk.citation.sourceUrl);
    if (page) {
      page.chunkIds.push(chunk.chunkId);
      if (page.section !== section) page.section = null;
    } else {
      pages.set(chunk.citation.sourceUrl, {
        url: chunk.citation.sourceUrl,
        title: chunk.citation.documentTitle,
        section,
        chunkIds: [chunk.chunkId],
      });
    }
  }
  return [...pages.values()];
}
