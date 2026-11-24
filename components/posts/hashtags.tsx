import { Fragment } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { channelHref, hashtagSegments } from '@/lib/domain/hashtags';

/**
 * A post's text with its `#tags` as links to their channels: only the tags
 * the post is filed under (`channels`), so a private post, or one written
 * before channels, links nothing and reads as it was written.
 */
export function HashtagText({ text, channels }: { text: string; channels: readonly string[] }) {
  if (channels.length === 0) return <>{text}</>;
  return (
    <>
      {hashtagSegments(text).map((segment, index) =>
        segment.kind === 'tag' && channels.includes(segment.name) ? (
          <Link key={index} href={channelHref(segment.name)} className="post-hashtag">
            {segment.raw}
          </Link>
        ) : (
          <Fragment key={index}>{segment.kind === 'tag' ? segment.raw : segment.text}</Fragment>
        ),
      )}
    </>
  );
}

/** A card's channels, under its question: the question itself is one link to the post, so its tags cannot be links inside it. */
export function ChannelChips({ channels, label }: { channels: readonly string[]; label: (name: string) => string }) {
  if (channels.length === 0) return null;
  return (
    <ul className="post-channels">
      {channels.map((name) => (
        <li key={name}>
          <Link href={channelHref(name)} aria-label={label(name)}>
            #{name}
          </Link>
        </li>
      ))}
    </ul>
  );
}
