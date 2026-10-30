/**
 * The TXT rendering of a retrieval result. architecture.md 12.1: JSON is the
 * canonical shape and TXT is derived from that object by this formatter --
 * never assembled from anything the JSON does not carry.
 */
import type { QueryDocsOutput } from '@/contracts/schemas';

export function renderContextText(output: QueryDocsOutput): string {
  const header = `Asset: ${output.assetId} (${output.version})`;
  if (output.chunks.length === 0) return `${header}\n\nNo relevant context found.\n`;

  const sections = output.chunks.map((chunk) => {
    const where = chunk.citation.section
      ? `${chunk.citation.documentTitle} > ${chunk.citation.section}`
      : chunk.citation.documentTitle;
    return `----------------------------------------\nTitle: ${where}\nSource: ${chunk.citation.sourceUrl}\n\n${chunk.text}\n`;
  });

  return `${header}\n\n${sections.join('\n')}`;
}
