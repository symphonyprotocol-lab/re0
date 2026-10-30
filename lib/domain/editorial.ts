/**
 * The creator kinds -- articles, audio episodes, Q&A -- as pure rules.
 * agent-first-proposal.md 3.2, 6.5, 6.6, 6.7.
 *
 * Each is an asset with its own version line, like any other: what differs
 * is where the text comes from. An article is written in the editor and its
 * published text is the `editor` source's content; an episode's indexed text is its title and
 * show notes only, never a transcript; a Q&A is the question and the
 * creator's written answer. Images and audio files sit in the private
 * bucket; their bytes are never indexed, only an image's caption is.
 *
 * Pure TypeScript -- domain layer rules apply.
 */
import { isVersionLabelShaped } from './asset';

export const EDITORIAL_KINDS = ['post', 'audio', 'qa'] as const;
export type EditorialKind = (typeof EDITORIAL_KINDS)[number];

export function isEditorialKind(value: unknown): value is EditorialKind {
  return value === 'post' || value === 'audio' || value === 'qa';
}

/**
 * The kinds the asset wizard creates as drafts, beside the connected
 * sources: an article or an episode starts there and is written in its
 * editor. A Q&A is made by answering a question, never from the wizard.
 */
export const WIZARD_EDITORIAL_KINDS = ['post', 'audio'] as const;
export type WizardEditorialKind = (typeof WIZARD_EDITORIAL_KINDS)[number];

export function isWizardEditorialKind(value: unknown): value is WizardEditorialKind {
  return value === 'post' || value === 'audio';
}

/** The asset ID namespace of each kind: `/posts/{handle}/{slug}` and so on (proposal 3.2). */
export const EDITORIAL_NAMESPACE: Record<EditorialKind, string> = {
  post: 'posts',
  audio: 'audio',
  qa: 'qa',
};

const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;

/** A slug the owner typed, folded; null when it cannot be one. */
export function normalizeEditorialSlug(value: string): string | null {
  const folded = value.trim().toLowerCase();
  if (!SLUG.test(folded) || isVersionLabelShaped(folded)) return null;
  return folded;
}

/** The slug a title suggests; '' when the title has nothing usable. */
export function editorialSlugFromTitle(title: string): string {
  const folded = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return normalizeEditorialSlug(folded) ?? '';
}

/** The asset ID; the handle is the workspace's public name, which these IDs need. */
export function editorialPublicId(kind: EditorialKind, handle: string, slug: string): string {
  return `/${EDITORIAL_NAMESPACE[kind]}/${handle}/${slug}`;
}

/* ------------------------------------------------------------------ limits */

export const EDITORIAL_LIMITS = {
  titleMax: 120,
  summaryMax: 400,
  /** An article, in characters: a long essay, not a book. */
  bodyMax: 200_000,
  notesMax: 20_000,
  questionMax: 2_000,
  answerMax: 20_000,
  imagesPerPost: 30,
  imageMaxBytes: 5 * 1024 * 1024,
  /** An episode: a two-hour MP3 fits, so does a long M4A; a WAV of more than ~15 minutes does not. */
  audioMaxBytes: 150 * 1024 * 1024,
  uploadUrlTtlSeconds: 15 * 60,
  /** How long a signed image URL works: one page view. */
  imageUrlTtlSeconds: 5 * 60,
  /** How long a signed playback URL works: long enough to start and seek an episode, too short to share. */
  audioUrlTtlSeconds: 15 * 60,
} as const;

export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** MP3, M4A and WAV, under the names browsers and encoders actually send. */
export const AUDIO_TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
};

/** The content type a file is stored and served as, from its declared type or its name. */
export function audioContentType(declared: string, name: string): string | null {
  const type = declared.trim().toLowerCase();
  if (AUDIO_TYPES[type]) return type === 'audio/mp3' ? 'audio/mpeg' : type;
  const extension = name.toLowerCase().split('.').pop();
  if (extension === 'mp3') return 'audio/mpeg';
  if (extension === 'm4a') return 'audio/mp4';
  if (extension === 'wav') return 'audio/wav';
  return null;
}

export function imageContentType(declared: string): string | null {
  const type = declared.trim().toLowerCase();
  return IMAGE_TYPES[type] ? type : null;
}

/** Keys from ids only (architecture.md 7), rooted in the workspace. */
export function mediaKey(workspaceId: string, assetId: string, mediaId: string, kind: 'image' | 'audio', extension: string): string {
  return `workspaces/${workspaceId}/media/${assetId}/${kind}-${mediaId}.${extension}`;
}

export class EditorialRefused extends Error {
  constructor(
    readonly code:
      | 'not_owner'
      | 'not_found'
      | 'no_handle'
      | 'invalid_slug'
      | 'slug_taken'
      | 'invalid_title'
      | 'invalid_body'
      | 'invalid_schedule'
      | 'invalid_media'
      | 'too_many_images'
      | 'storage_exceeded'
      | 'not_uploaded'
      | 'no_audio'
      | 'storage_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'EditorialRefused';
  }
}

/* ------------------------------------------------------------------ images */

/** `![caption](media:<uuid>)` -- how the editor refers to an uploaded image. */
const MEDIA_IMAGE = /!\[([^\]\n]{0,300})\]\(media:([0-9a-f-]{36})\)/g;
/** Any other markdown image; external images are not shown (they track readers). */
const EXTERNAL_IMAGE = /!\[([^\]\n]{0,300})\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** The uploaded images a body refers to, in order, without repeats. */
export function referencedMedia(body: string): string[] {
  const ids: string[] = [];
  for (const match of body.matchAll(MEDIA_IMAGE)) {
    const id = match[2]!;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The text that is indexed for a body: every image replaced by its caption
 * -- the stored caption when there is one, else the alt text -- and nothing
 * when it has neither. The bytes are never part of it (proposal 6.5).
 */
export function indexedBody(body: string, captions: ReadonlyMap<string, string | null> = new Map()): string {
  return body
    .replace(MEDIA_IMAGE, (_, alt: string, id: string) => {
      const caption = (captions.get(id) ?? '').trim() || alt.trim();
      return caption ? `[Image: ${caption}]` : '';
    })
    .replace(EXTERNAL_IMAGE, (_, alt: string) => (alt.trim() ? `[Image: ${alt.trim()}]` : ''));
}

/** An article's whole indexed document: title, summary, then the body. */
export function postDocument(input: { title: string; summary: string | null; body: string; captions?: ReadonlyMap<string, string | null> }): string {
  const parts = [`# ${input.title.trim()}`];
  if (input.summary?.trim()) parts.push(input.summary.trim());
  parts.push(indexedBody(input.body, input.captions).trim());
  return `${parts.filter(Boolean).join('\n\n')}\n`;
}

/** An episode's indexed document: its title and show notes, never what is said in it (6.6). */
export function episodeDocument(input: { title: string; notes: string }): string {
  return `# ${input.title.trim()}\n\n${input.notes.trim()}\n`;
}

/**
 * A Q&A's indexed document: the question and the creator's written answer,
 * and nothing else -- not the comment it may have come from, and not the
 * attached audio, which is not transcribed (6.7, 6.8).
 */
export function qaDocument(input: { question: string; answer: string }): string {
  return `# ${input.question.trim()}\n\n${input.answer.trim()}\n`;
}

/* ---------------------------------------------------------------- schedule */

/**
 * When a post is to go live: `now` for an immediate publication, a future
 * instant for a scheduled one. A time in the past (or within a minute of
 * now) is an immediate publish; more than a year ahead is refused.
 */
export function publishInstant(value: string | null | undefined, now: Date): Date | null {
  if (!value || value.trim() === '') return null;
  /* A `datetime-local` value carries no zone; the editor says UTC, so it is read as UTC. */
  const trimmed = value.trim();
  const at = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed) ? trimmed : `${trimmed}Z`);
  if (Number.isNaN(at.getTime())) throw new EditorialRefused('invalid_schedule', 'the publication time is not a date');
  if (at.getTime() - now.getTime() > 366 * 86_400_000) {
    throw new EditorialRefused('invalid_schedule', 'a post can be scheduled at most a year ahead');
  }
  return at.getTime() - now.getTime() <= 60_000 ? null : at;
}
