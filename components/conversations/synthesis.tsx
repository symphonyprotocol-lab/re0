'use client';

import { SYNTHESIS_FEE } from '@/lib/constants';
import type { CitationSnapshot } from '@/lib/domain/answer';
import type { SynthesisPart } from '@/lib/domain/chat-message';
import { SYNTHESIS_LABELS, type SynthesisSource } from '@/lib/domain/synthesis';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Feedback, I, Typing } from '@/components/chat/message-parts';
import { Markdown } from '@/components/chat/markdown';
import type { ReeDirectory } from '@/components/conversations/chat-room';

/** "综合这 N 个回答 · 30 credits", under the last answer of a question two or more Rees answered. */
export function SynthesisButton({ answers, disabled, onClick }: { answers: number; disabled: boolean; onClick: () => void }) {
  const { t, locale } = useI18n();
  const r = t.conversations.roundtable;
  return (
    <div className="synthesis-action">
      <button type="button" className="btn secondary sm" onClick={onClick} disabled={disabled}>
        <I name="sparkle" />
        {fill(r.synthesize, { n: answers })}
        <small>· {fill(r.price, { n: formatNumber(SYNTHESIS_FEE, locale) })}</small>
      </button>
    </div>
  );
}

/** The marker's text when shown: the Ree's name, and the citation number when it names one. */
function markerLabel(marker: string, reeIds: readonly string[], directory: ReeDirectory, removed: string): { reeId: string | null; name: string; index: number | null } {
  const label = marker[0]!;
  const reeId = reeIds[SYNTHESIS_LABELS.indexOf(label as (typeof SYNTHESIS_LABELS)[number])] ?? null;
  const index = marker.length > 1 ? Number(marker.slice(1)) : null;
  return { reeId, name: (reeId && directory[reeId]?.name) || removed, index };
}

/**
 * The synthesis under a question (ree-council-proposal.md 4.1): set apart
 * from the Rees' bubbles, its four sections, each point's sources as chips
 * that open the original Ree's citation, and its own 有用 / 没用. While it
 * streams the raw text shows; once done, only the markers the server kept.
 */
export function SynthesisBubble({
  part,
  directory,
  vote,
  onVote,
  onSource,
}: {
  part: SynthesisPart;
  directory: ReeDirectory;
  vote: 'up' | 'down' | null;
  onVote: (value: 'up' | 'down') => void;
  onSource: (citation: CitationSnapshot, reeId: string) => void;
}) {
  const { t, locale } = useI18n();
  const r = t.conversations.roundtable;
  const bySource = new Map<string, SynthesisSource>(part.sources.map((source) => [source.marker, source]));
  const streaming = part.state === 'streaming';
  /* Copied, a marker reads as the Ree's name: "[产品手册 Ree 2]". */
  const copyText = part.content.replace(/\[([A-E])(\d{1,2})?\]/g, (marker) => {
    const { name, index } = markerLabel(marker.slice(1, -1), part.reeIds, directory, t.conversations.room.removedRee);
    return `[${index === null ? name : `${name} ${index}`}]`;
  });

  const source = (marker: string, key: string) => {
    const { name, index } = markerLabel(marker, part.reeIds, directory, t.conversations.room.removedRee);
    const kept = bySource.get(marker);
    const text = index === null ? name : `${name} ${index}`;
    if (kept?.citation) {
      const citation = kept.citation;
      return (
        <button key={key} type="button" className="synthesis-source" onClick={() => onSource(citation, kept.reeId)} aria-label={fill(r.source, { name, n: citation.index })}>
          {text}
        </button>
      );
    }
    /* A whole answer, or a marker not yet checked while the text streams. */
    return (
      <span key={key} className="synthesis-source plain">
        {text}
      </span>
    );
  };

  return (
    <article className="message synthesis" data-synthesis={part.requestId} aria-busy={streaming}>
      <div className="message-head">
        <span className="synthesis-mark">
          <I name="sparkle" />
        </span>
        <strong>{r.title}</strong>
        <small>{fill(r.subtitle, { n: part.reeIds.length })}</small>
      </div>
      <div className="answer-text">
        {part.state === 'failed' ? (
          <p className="answer-failed">{r.failed}</p>
        ) : streaming && !part.content ? (
          <>
            <p className="synthesis-status">{r.streaming}</p>
            <Typing />
          </>
        ) : (
          /* A bare `[n]` belongs to no one here; the server removes it, and while streaming it is not drawn. */
          <Markdown className="answer-markdown" text={part.content} citation={() => null} source={source} />
        )}
      </div>
      {part.state !== 'failed' && (
        <div className="synthesis-note">
          <I name="info" />
          <span>{r.note}</span>
        </div>
      )}
      {part.state === 'done' && part.synthesisId && (
        <Feedback text={copyText} vote={vote} onVote={onVote} cost={fill(t.chat.cost, { credits: formatNumber(part.cost, locale) })} />
      )}
    </article>
  );
}
