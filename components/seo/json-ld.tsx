/**
 * One structured-data block, as a crawler reads it.
 *
 * The data is ours, never a visitor's, but the string still goes through the
 * one escape that matters inside a `<script>`: a `<` in a library title must
 * not be able to close the element. Everything else JSON already escapes.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}
