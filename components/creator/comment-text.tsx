import { commentPieces } from '@/lib/domain/comment';

/**
 * A comment body, rendered as untrusted text (agent-first-proposal.md 6.8):
 * no markup is ever interpreted; a URL becomes a link marked `nofollow ugc`,
 * opened in a new tab and flagged as leaving the site.
 */
export function CommentText({ body, externalLabel }: { body: string; externalLabel: string }) {
  return (
    <p className="text-[13.5px] leading-[1.7] whitespace-pre-wrap break-words text-ink">
      {commentPieces(body).map((piece, at) =>
        piece.kind === 'text' ? (
          <span key={at}>{piece.text}</span>
        ) : (
          <a
            key={at}
            href={piece.href}
            rel="nofollow ugc noopener noreferrer"
            target="_blank"
            title={`${externalLabel}: ${piece.href}`}
            className="text-brandink underline underline-offset-2"
          >
            {piece.text}
            <span className="ml-0.5 text-[10px] text-muted">↗ {externalLabel}</span>
          </a>
        ),
      )}
    </p>
  );
}
