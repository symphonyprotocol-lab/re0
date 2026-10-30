/**
 * The little Markdown a cited sentence can carry: bold, inline code, a
 * bullet or a heading at the start of a line. Rendered by hand rather than
 * by a Markdown asset because the text is a single sentence with its
 * line breaks kept (`whitespace-pre-line` on the paragraph), and a block
 * renderer would fight the inline footnotes that follow it.
 *
 * Shared by every surface that shows a bound sentence -- the playground
 * and the showcase page here, the widget in its own script
 * (public/embed-app.js `claimParagraph`, the same rules by hand) -- so a
 * model that bolds a plan name reads the same on all three.
 */
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

export function ClaimText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, at) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        const body = heading ? heading[1]! : line.replace(/^[-*]\s+/, '• ');
        const runs = body.split(INLINE).map((run, index) =>
          run.startsWith('**') && run.endsWith('**') ? (
            <strong key={index} className="font-medium text-ink">
              {run.slice(2, -2)}
            </strong>
          ) : run.startsWith('`') && run.endsWith('`') ? (
            <code key={index} className="rounded bg-tray px-1 font-mono text-[11px] text-ink">
              {run.slice(1, -1)}
            </code>
          ) : (
            run
          ),
        );
        return (
          <span key={at}>
            {at > 0 ? '\n' : null}
            {heading ? <strong className="font-medium text-ink">{runs}</strong> : runs}
          </span>
        );
      })}
    </>
  );
}
