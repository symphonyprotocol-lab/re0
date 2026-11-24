/**
 * Hashtags → channels: `#travel` in a public post puts it in the channel
 * `travel` (lib/services/channels.ts), made the first time anyone uses it.
 * One scanner serves both the tags a post is filed under and the links the
 * post's text shows, so the two always agree.
 *
 * The rules:
 * - A tag is `#` (or the full-width `＃`) and a name of Unicode letters,
 *   digits, combining marks, `_` and `-`: `#travel`, `#旅行`, `#new_york`,
 *   `#sci-fi`. It must start with a letter, digit or `_` and contain at least
 *   one letter, so `#1` and `#2024` (issue numbers, rankings) are not tags.
 *   Trailing hyphens are not part of it (`#travel-` is `travel`).
 * - The `#` starts a tag only at the start of the text or after a space or a
 *   punctuation mark other than `&`, `/`, `#`, `_` and `-`: `C#`, `a#b`,
 *   `&#123;` and `## Heading` are no tags. A closing `#` right after the
 *   name is allowed Weibo-style: `#旅行#` is the tag `旅行`.
 * - URLs (`http(s)://…`, `www.…`) and inline code (`` `…` ``) are skipped,
 *   so a link's `#anchor` is never a tag. A markdown heading `# Title` is not
 *   one either: the name must follow the `#` with no space.
 * - Names are NFKC-normalised and lower-cased (`#Travel`, `#ＴＲＡＶＥＬ` and
 *   `#travel` are one channel) and 1–{@link HASHTAG_MAX_LENGTH} characters;
 *   a longer run is not a tag at all, rather than cut into one.
 * - A post is filed under its first {@link POST_HASHTAG_MAX} distinct tags,
 *   question first, then the detail.
 */

/** The longest channel name, in characters (code points). */
export const HASHTAG_MAX_LENGTH = 32;
/** The most channels one post is filed under. */
export const POST_HASHTAG_MAX = 10;

/** A piece of text: plain, or a tag as written (`raw`, with its `#`) and its channel name. */
export type HashtagSegment = { kind: 'text'; text: string } | { kind: 'tag'; raw: string; name: string };

const NAME_CHAR = /[\p{L}\p{N}\p{M}_-]/u;
const NAME_START = /[\p{L}\p{N}\p{M}_]/u;
const HAS_LETTER = /\p{L}/u;
/** After these a `#` is part of a word, an entity or a path, not a tag. */
const NOT_BEFORE = /[\p{L}\p{N}\p{M}_&/#＃-]/u;
/** Stretches never scanned for tags: URLs and inline code. */
const SKIPPED = /https?:\/\/\S+|www\.\S+|`[^`\n]*`/giu;

/** A channel name as stored and linked: NFKC, lower case. Null when it is not a valid name. */
export function channelNameOf(value: string): string | null {
  const name = value.normalize('NFKC').toLowerCase().replace(/^[#＃]/u, '').trim();
  if (!name) return null;
  const chars = [...name];
  if (chars.length > HASHTAG_MAX_LENGTH) return null;
  if (!NAME_START.test(chars[0]!) || chars[chars.length - 1] === '-' || !chars.every((char) => NAME_CHAR.test(char)) || !HAS_LETTER.test(name)) return null;
  return name;
}

/** Splits text into plain runs and tags, in order; joined back (`raw` for tags) it is the text again. */
export function hashtagSegments(text: string): HashtagSegment[] {
  const out: HashtagSegment[] = [];
  let plain = '';
  const push = (value: string) => {
    plain += value;
  };
  const flush = () => {
    if (plain) out.push({ kind: 'text', text: plain });
    plain = '';
  };
  let last = 0;
  for (const match of text.matchAll(SKIPPED)) {
    scan(text.slice(last, match.index), text[match.index - 1] ?? '');
    push(match[0]);
    last = match.index + match[0].length;
  }
  scan(text.slice(last), text[last - 1] ?? '');
  flush();
  return out;

  /** Scans a stretch outside URLs and code; `before` is the character just before it. */
  function scan(part: string, before: string) {
    const chars = [...part];
    let i = 0;
    let previous = before;
    while (i < chars.length) {
      const char = chars[i]!;
      if ((char === '#' || char === '＃') && !(previous && NOT_BEFORE.test(previous))) {
        let end = i + 1;
        while (end < chars.length && NAME_CHAR.test(chars[end]!)) end += 1;
        /* Trailing hyphens end the sentence, not the tag. */
        let stop = end;
        while (stop > i + 1 && chars[stop - 1] === '-') stop -= 1;
        const body = chars.slice(i + 1, stop).join('');
        /*
         * A tag runs to the end of its name. Another `#` right after it closes
         * it Weibo-style (`#旅行#`) when no name follows; `#a#b` is no tag.
         */
        const next = chars[end];
        const hashNext = next === '#' || next === '＃';
        const closed = hashNext && stop === end && !(chars[end + 1] !== undefined && NAME_CHAR.test(chars[end + 1]!));
        const name = body && (!hashNext || closed) ? channelNameOf(body) : null;
        if (name) {
          const close = closed ? end + 1 : stop;
          flush();
          out.push({ kind: 'tag', raw: chars.slice(i, close).join(''), name });
          i = close;
          previous = chars[close - 1]!;
          continue;
        }
        /* Not a tag: the whole run is plain, so nothing inside it starts one. */
        push(chars.slice(i, end).join(''));
        previous = chars[end - 1]!;
        i = end;
        continue;
      }
      push(char);
      previous = char;
      i += 1;
    }
  }
}

/** The channels a post's texts file it under: distinct names in order of first use, at most {@link POST_HASHTAG_MAX}. */
export function extractHashtags(...texts: (string | null | undefined)[]): string[] {
  const names: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const segment of hashtagSegments(text)) {
      if (segment.kind !== 'tag' || names.includes(segment.name)) continue;
      names.push(segment.name);
      if (names.length >= POST_HASHTAG_MAX) return names;
    }
  }
  return names;
}

/** A channel's page. */
export function channelHref(name: string): string {
  return `/c/${encodeURIComponent(name)}`;
}
