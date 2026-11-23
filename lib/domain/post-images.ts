/**
 * Images on a post (2026-11-23): up to `POST_IMAGE_MAX` jpg / png / webp
 * files of at most `POST_IMAGE_MAX_BYTES` each, uploaded by the browser
 * straight to the private Blob store under the author's prefix
 * (`post-images/<user>/<random>.<ext>`) and named on publish. They are
 * read by multimodal models directly: the review sees them, the answers
 * see them, and a short OCR + description (`post.image_text`, written by
 * the generation model once) stands in for them wherever only text goes --
 * the embedding that matches Rees, retrieval, the synthesis.
 */
import { REE_IMAGE_EXTENSIONS } from '@/lib/constants';

export const POST_IMAGE_MAX = 4;
export const POST_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const POST_IMAGE_TYPES = REE_IMAGE_EXTENSIONS;
export type PostImageType = keyof typeof POST_IMAGE_TYPES;
/** The description stored for the text-only steps: long enough for a screenshot's text, short enough for an embedding. */
export const POST_IMAGE_TEXT_MAX_CHARS = 2_000;
export const POST_IMAGE_TEXT_OUTPUT_TOKENS = 1_200;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PATH = new RegExp(`^post-images/(${UUID})/${UUID}\\.(?:jpg|png|webp)$`);

export function isPostImageType(value: unknown): value is PostImageType {
  return typeof value === 'string' && Object.hasOwn(POST_IMAGE_TYPES, value);
}

/** Where one upload of this user goes. */
export function postImagePath(userId: string, id: string, contentType: PostImageType): string {
  return `post-images/${userId.toLowerCase()}/${id.toLowerCase()}.${POST_IMAGE_TYPES[contentType]}`;
}

/** The owner of a post image's pathname, or null when it is not one exactly as the uploader writes it. */
export function postImageOwner(pathname: string): string | null {
  return PATH.exec(pathname)?.[1] ?? null;
}

/**
 * The pathnames a publish names, in order: each this user's own upload
 * shape, no repeats, at most `POST_IMAGE_MAX`. Missing or empty is no images.
 */
export function parsePostImages(raw: unknown, userId: string): string[] | 'invalid_images' | 'too_many_images' {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return 'invalid_images';
  if (raw.length > POST_IMAGE_MAX) return 'too_many_images';
  const paths: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || postImageOwner(entry) !== userId.toLowerCase() || paths.includes(entry)) return 'invalid_images';
    paths.push(entry);
  }
  return paths;
}

/** What the text-only steps read for a post: its question, its detail and what its images say. */
export function postSubject(row: { question: string; detail: string; imageText?: string | null }): string {
  return [row.question, row.detail, row.imageText ? `[Images] ${row.imageText}` : ''].filter(Boolean).join('\n');
}

export const IMAGE_TEXT_INSTRUCTIONS = [
  'You describe the images attached to a question someone asked, for a search index and for reviewers who cannot see them.',
  'For each image, in order, write one short paragraph starting with "Image N:": first every piece of readable text in it, transcribed as written (keep its language), then a plain description of what it shows that bears on the question.',
  'Do not answer the question, do not speculate beyond what is visible, no preamble. Plain text, at most 300 words in all.',
].join('\n');

export function imageTextPrompt(question: string, count: number): string {
  return `Question: ${question}\n\nDescribe the ${count} attached image${count === 1 ? '' : 's'}.`;
}

/** The model's description, trimmed to what is stored. */
export function cleanImageText(text: string): string {
  return text.replace(/\s+\n/g, '\n').trim().slice(0, POST_IMAGE_TEXT_MAX_CHARS);
}

/** The note a reviewing or answering model reads when the post's images come with the text. */
export function imagesNote(count: number): string {
  return `The asker attached ${count} image${count === 1 ? '' : 's'} (below); ${count === 1 ? 'it is' : 'they are'} part of the question.`;
}
