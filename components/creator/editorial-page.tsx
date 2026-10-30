import Link from 'next/link';
import { LockIcon } from '@/components/ui/icons';
import type { CommentThread } from '@/lib/application/comments';
import type { EditorialReading } from '@/lib/application/editorial';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import { CommentSection } from './comment-section';
import { Markdown } from './markdown';

/**
 * The reading and listening page of an article, an episode or a Q&A
 * (agent-first-proposal.md 6.3, 6.5-6.7). What arrives here was already cut
 * to the viewer's sight: a summary sight carries no body and no audio, so a
 * paid asset's content is not merely hidden from a non-subscriber -- it was
 * never read for them. Audio plays through `/media/{id}`, a per-request
 * signed URL, with the player's download control off. `limited`: a
 * session-less reader past the anonymous reading limit got the summary of a
 * free asset, and is told to wait or sign in rather than to subscribe.
 */
export function EditorialPage({
  reading,
  limited = false,
  thread,
  signedIn,
  commentOutcome,
  t,
  locale,
}: {
  reading: EditorialReading;
  limited?: boolean;
  thread: CommentThread;
  signedIn: boolean;
  commentOutcome: string | null;
  t: Dictionary;
  locale: string;
}) {
  const r = t.creator.reading;
  const kinds = t.channels.kinds as Record<string, string>;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const full = reading.sight === 'full';

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-8 px-5 pt-12 pb-20">
      {reading.channel ? (
        <nav className="text-caption text-muted">
          <Link href={`/channels/${reading.channel.slug}`} className="hover:text-ink">
            {reading.channel.title}
          </Link>
          <span className="px-1.5">/</span>
          <span className="text-ink">{kinds[reading.kind] ?? reading.kind}</span>
        </nav>
      ) : null}
      {!reading.live ? <p className="rounded-md border border-line bg-subtle px-4 py-3 text-caption text-steel">{r.draftNotice}</p> : null}

      <header className="flex flex-col gap-3">
        <h1 className="text-[32px] leading-[1.3] font-semibold text-ink">{reading.kind === 'qa' ? (reading.qa?.question ?? reading.title) : reading.title}</h1>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted">
          {reading.ownerHandle ? (
            <span>
              {r.by}{' '}
              <Link href={`/u/${reading.ownerHandle}`} className="text-brandink hover:underline">
                @{reading.ownerHandle}
              </Link>
            </span>
          ) : null}
          {reading.publishedAt ? <span>{fill(r.published, { date: date.format(reading.publishedAt) })}</span> : null}
          {reading.versionLabel ? <span className="font-mono">{fill(r.version, { label: reading.versionLabel })}</span> : null}
          {reading.access === 'paid' ? (
            <span className="flex items-center gap-1 text-privink">
              <LockIcon size={12} />
              {r.paidTitle}
            </span>
          ) : null}
        </p>
        {reading.kind === 'qa' ? (
          <p className="text-caption text-steel">{reading.qa?.askerName ? fill(r.askedBy, { name: reading.qa.askerName }) : r.askedAnonymously}</p>
        ) : reading.summary ? (
          <p className="text-body text-steel">{reading.summary}</p>
        ) : null}
      </header>

      {full ? (
        <article className="flex flex-col gap-6">
          {reading.kind === 'audio' || (reading.kind === 'qa' && reading.audioMediaId) ? (
            <section className="flex flex-col gap-2 rounded-lg border border-line bg-card p-4">
              <p className="text-[12px] font-medium text-steel">{reading.kind === 'qa' ? r.attachedAudio : r.audio}</p>
              {reading.audioMediaId ? (
                <audio controls preload="none" controlsList="nodownload noplaybackrate" className="w-full" src={`/media/${reading.audioMediaId}`} />
              ) : (
                <p className="text-[12px] text-muted">{r.noAudio}</p>
              )}
            </section>
          ) : null}
          {reading.kind === 'qa' ? <p className="text-[12px] font-medium text-steel">{r.answer}</p> : null}
          {reading.body ? <Markdown source={reading.body} /> : null}
        </article>
      ) : limited ? (
        <section className="flex flex-col gap-3 rounded-lg border border-line bg-subtle p-6">
          <p className="text-[15px] font-medium text-ink">{r.limitedTitle}</p>
          <p className="text-[13px] leading-[1.6] text-steel">{r.limitedBody}</p>
          <Link href={`/login?returnTo=${encodeURIComponent(`/assets${reading.publicId}`)}`} className="text-[13px] text-brandink hover:underline">
            {r.signIn}
          </Link>
        </section>
      ) : (
        <section className="flex flex-col gap-3 rounded-lg border border-line bg-subtle p-6">
          <p className="flex items-center gap-2 text-[15px] font-medium text-ink">
            <LockIcon size={15} />
            {r.paidTitle}
          </p>
          <p className="text-[13px] leading-[1.6] text-steel">{r.paidBody}</p>
          {reading.channel ? (
            <Link href={`/channels/${reading.channel.slug}#subscribe`} className="text-[13px] text-brandink hover:underline">
              {r.subscribeCta}
            </Link>
          ) : null}
        </section>
      )}

      {thread.visible ? (
        <CommentSection assetId={reading.id} publicId={reading.publicId} thread={thread} signedIn={signedIn} outcome={commentOutcome} t={t} locale={locale} />
      ) : null}
    </div>
  );
}
