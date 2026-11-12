/**
 * Structured data for search engines (lib/seo.ts builds the graphs). A data
 * block is never executed, so the page's script nonce does not apply; `<`
 * is escaped so a Ree's name cannot close the tag.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }} />;
}
