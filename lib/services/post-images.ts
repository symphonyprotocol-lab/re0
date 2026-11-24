/**
 * Images on posts (lib/domain/post-images.ts): the upload token, the check
 * of what a publish names, the rows, who may see them, the parts a
 * multimodal model reads, and `post.image_text` -- the generation model's
 * OCR + description that matching, retrieval and the synthesis read in the
 * images' place.
 *
 * Every generation entry reads images (lib/services/models.ts refuses one
 * that cannot), so the images go to whichever entry answers; through AI
 * Gateway the request also asks to be routed only to providers that take
 * image input (`has: ['vision']`). Image tokens are input tokens: the model
 * call log and the provider cost record them like any other.
 */
import { generateText, type FilePart, type ModelMessage, type TextPart } from 'ai';
import { and, asc, eq, inArray, isNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  cleanImageText,
  IMAGE_TEXT_INSTRUCTIONS,
  imageTextPrompt,
  isPostImageType,
  POST_IMAGE_UPLOAD_MAX_BYTES,
  POST_IMAGE_TYPES,
  postImageOwner,
  postImagePath,
  POST_IMAGE_TEXT_OUTPUT_TOKENS,
  POST_IMAGE_THUMB_MAX_BYTES,
  POST_IMAGE_THUMB_TYPE,
  postImageThumbPath,
  type PostImageType,
} from '@/lib/domain/post-images';
import { uploadTicket, readBlob, type UploadTicket } from '@/lib/infra/blob';
import { blobInfo } from '@/lib/infra/blob-access';
import { db, schema, type Executor } from '@/lib/infra/db';
import { isUuid } from '@/lib/domain/list';
import { generationForUser } from '@/lib/services/generation';
import { hasActivePlan } from '@/lib/services/billing';
import { chainFor } from '@/lib/infra/ai/models';
import { gatewayModelVision } from '@/lib/infra/ai/gateway-generation-pricing';

const { post, postImage } = schema;

export interface PostImageRow {
  pathname: string;
  contentType: PostImageType;
  bytes: number;
  /** The feed's small copy, when the composer uploaded one. */
  thumbPathname: string | null;
}

/** What a page shows for one image: where `/media` serves it, and its small copy for the feed (the image itself when it has none). */
export interface PostImageView {
  url: string;
  thumbUrl: string;
}

/* --------------------------------------------------------- who can read them */

/**
 * Whether every generation entry a post of this user's may reach reads
 * images: their audience's list (primary and backups) and the Free list,
 * which the review and the AI answer use whatever the plan. Entries enabled
 * before images existed are not re-checked by the console, so a publish
 * with images asks here and is refused (`images_unsupported`) rather than
 * left to fail its review. A gateway model the catalog cannot speak for
 * right now is given the benefit of the doubt: its calls ask for vision
 * routing and fail loudly if none is there.
 */
export async function imagesReadableFor(userId: string): Promise<boolean> {
  const plan = await hasActivePlan(db(), userId);
  const chains = await Promise.all([chainFor('generation', 'free'), ...(plan ? [chainFor('generation', 'plan')] : [])]);
  for (const endpoint of chains.flat()) {
    const reads = endpoint.transport === 'gateway' ? ((await gatewayModelVision(endpoint.model)) ?? true) : endpoint.supportsImages === true;
    if (!reads) return false;
  }
  return true;
}

/* ----------------------------------------------------------------- uploads */

/** A Blob token for one (already scaled) image of a post this user is about to publish: their prefix, the type, at most `POST_IMAGE_UPLOAD_MAX_BYTES`. */
export async function postImageTicket(userId: string, input: { contentType?: unknown; size?: unknown }): Promise<(UploadTicket & { contentType: string }) | null> {
  const size = Number(input.size ?? 0);
  if (!isPostImageType(input.contentType) || !Number.isSafeInteger(size) || size <= 0 || size > POST_IMAGE_UPLOAD_MAX_BYTES) return null;
  const ticket = await uploadTicket(postImagePath(userId, crypto.randomUUID(), input.contentType), { contentTypes: [input.contentType], maxBytes: POST_IMAGE_UPLOAD_MAX_BYTES });
  return { ...ticket, contentType: input.contentType };
}

/**
 * A Blob token for the thumbnail of one of this user's uploads (`of`): beside
 * it, JPEG, at most `POST_IMAGE_THUMB_MAX_BYTES`. The pathname is the
 * image's, so a thumbnail can only ever stand for its own image.
 */
export async function postImageThumbTicket(userId: string, input: { of?: unknown; size?: unknown }): Promise<(UploadTicket & { contentType: string }) | null> {
  const size = Number(input.size ?? 0);
  if (typeof input.of !== 'string' || postImageOwner(input.of) !== userId.toLowerCase()) return null;
  const pathname = postImageThumbPath(input.of);
  if (!pathname || !Number.isSafeInteger(size) || size <= 0 || size > POST_IMAGE_THUMB_MAX_BYTES) return null;
  const ticket = await uploadTicket(pathname, { contentTypes: [POST_IMAGE_THUMB_TYPE], maxBytes: POST_IMAGE_THUMB_MAX_BYTES });
  return { ...ticket, contentType: POST_IMAGE_THUMB_TYPE };
}

/**
 * The uploads a publish names, checked in Blob: there, an allowed type
 * matching the extension, at most `POST_IMAGE_UPLOAD_MAX_BYTES`. Null when
 * any is not. Each one's thumbnail is kept when it is there and well formed;
 * without it the feed shows the image.
 */
export async function checkedImages(userId: string, pathnames: readonly string[]): Promise<PostImageRow[] | null> {
  if (pathnames.some((pathname) => postImageOwner(pathname) !== userId.toLowerCase())) return null;
  const rows = await Promise.all(
    pathnames.map(async (pathname): Promise<PostImageRow | null> => {
      const thumbPathname = postImageThumbPath(pathname)!;
      const [info, thumb] = await Promise.all([blobInfo(pathname), blobInfo(thumbPathname)]);
      if (!info || info.size <= 0 || info.size > POST_IMAGE_UPLOAD_MAX_BYTES || !isPostImageType(info.contentType)) return null;
      if (!pathname.endsWith(`.${POST_IMAGE_TYPES[info.contentType]}`)) return null;
      const thumbOk = thumb && thumb.size > 0 && thumb.size <= POST_IMAGE_THUMB_MAX_BYTES && thumb.contentType === POST_IMAGE_THUMB_TYPE;
      return { pathname, contentType: info.contentType, bytes: info.size, thumbPathname: thumbOk ? thumbPathname : null };
    }),
  );
  return rows.every((row) => row !== null) ? rows : null;
}

export async function attachImages(tx: Executor, postId: string, images: readonly PostImageRow[]): Promise<void> {
  if (images.length === 0) return;
  await tx.insert(postImage).values(images.map((image, position) => ({ postId, position, pathname: image.pathname, contentType: image.contentType, bytes: image.bytes, thumbPathname: image.thumbPathname })));
}

/**
 * The post (`postId`, a column of the query) has exactly these images, in
 * this order -- none for an empty list. Each upload has its own pathname, so
 * this is "the same submit" for duplicate detection.
 */
export function hasSameImages(postId: SQL | AnyColumn, pathnames: readonly string[]): SQL {
  const wanted = pathnames.length ? sql`array[${sql.join(pathnames.map((pathname) => sql`${pathname}`), sql`, `)}]::text[]` : sql`'{}'::text[]`;
  return sql`coalesce((select array_agg(pi.pathname order by pi.position) from ${postImage} pi where pi.post_id = ${postId}), '{}'::text[]) = ${wanted}`;
}

/** 转为公开: the public copy shows the same images (the same objects). */
export async function copyImages(tx: Executor, fromPostId: string, toPostId: string): Promise<void> {
  const rows = await imageRows(fromPostId, tx);
  await attachImages(tx, toPostId, rows);
}

async function imageRows(postId: string, executor: Executor = db()): Promise<PostImageRow[]> {
  const rows = await executor.select({ pathname: postImage.pathname, contentType: postImage.contentType, bytes: postImage.bytes, thumbPathname: postImage.thumbPathname }).from(postImage).where(eq(postImage.postId, postId)).orderBy(asc(postImage.position));
  return rows.map((row) => ({ ...row, contentType: row.contentType as PostImageType }));
}

/**
 * Each post's images, in order, as pages show them: by the row's own id,
 * never the stored pathname -- that carries the author's id, which would
 * name the author of an anonymous post (and tie their anonymous posts
 * together). A 转为公开 copy has rows of its own, so its URLs do not lead
 * back to the private post either.
 */
export async function imagesFor(postIds: readonly string[]): Promise<Map<string, PostImageView[]>> {
  const found = new Map<string, PostImageView[]>();
  if (postIds.length === 0) return found;
  const rows = await db()
    .select({ id: postImage.id, postId: postImage.postId, thumbPathname: postImage.thumbPathname })
    .from(postImage)
    .where(inArray(postImage.postId, [...postIds]))
    .orderBy(asc(postImage.postId), asc(postImage.position));
  for (const row of rows) {
    const url = postImageUrl(row.id);
    found.set(row.postId, [...(found.get(row.postId) ?? []), { url, thumbUrl: row.thumbPathname ? postImageUrl(row.id, 'thumb') : url }]);
  }
  return found;
}

export function postImageUrl(id: string, size?: 'thumb'): string {
  return `/media/post-images/${id}${size ? `?size=${size}` : ''}`;
}

/**
 * The stored object of one image row (`/media/post-images/<id>`), when this
 * viewer may see it: it belongs to a post they may read -- a public
 * published one out of the trash, or one of their own in any state -- or,
 * for an administrator, to any public post (reports and take-downs are
 * reviewed with the images). Null otherwise.
 */
export async function visiblePostImage(id: string, viewerId: string | null, administrator = false): Promise<{ pathname: string; contentType: string; thumbPathname: string | null } | null> {
  if (!isUuid(id)) return null;
  const [row] = await db()
    .select({ pathname: postImage.pathname, contentType: postImage.contentType, thumbPathname: postImage.thumbPathname })
    .from(postImage)
    .innerJoin(post, eq(post.id, postImage.postId))
    .where(
      and(
        eq(postImage.id, id),
        or(
          and(eq(post.visibility, 'public'), eq(post.status, 'published'), isNull(post.deletedAt)),
          viewerId ? eq(post.userId, viewerId) : undefined,
          administrator ? eq(post.visibility, 'public') : undefined,
        ),
      ),
    )
    .limit(1);
  if (!row || !postImageOwner(row.pathname)) return null;
  /* Only ever the image's own thumbnail, whatever the row says. */
  return { ...row, thumbPathname: row.thumbPathname && row.thumbPathname === postImageThumbPath(row.pathname) ? row.thumbPathname : null };
}

/* ------------------------------------------------------------ for models */

export type ImagePart = FilePart;

/**
 * The post's images as message parts, read from Blob. An image that cannot
 * be read is left out -- or, `strict` (the review, which must see them
 * all), throws.
 */
export async function imageParts(postId: string, options: { strict?: boolean } = {}): Promise<ImagePart[]> {
  const rows = await imageRows(postId);
  const parts = await Promise.all(
    rows.map(async (row): Promise<ImagePart | null> => {
      const data = await readBlob(row.pathname).catch(() => null);
      if (!data && options.strict) throw new Error(`post image unreadable: ${row.pathname}`);
      return data ? { type: 'file', mediaType: row.contentType, data } : null;
    }),
  );
  return parts.filter((part): part is ImagePart => part !== null);
}

/** One user message: the text, then the images. */
export function withImages(text: string, images: readonly ImagePart[] = []): ModelMessage {
  if (images.length === 0) return { role: 'user', content: text };
  const content: (TextPart | FilePart)[] = [{ type: 'text', text }, ...images];
  return { role: 'user', content };
}

/** A call carrying images, through AI Gateway, goes only to providers that take image input; other transports ignore it. */
export function visionOptions(images: readonly ImagePart[] = []): { providerOptions?: { gateway: { has: ['vision'] } } } {
  return images.length > 0 ? { providerOptions: { gateway: { has: ['vision'] } } } : {};
}

/** Writes the images' description once; reads the stored one after. Throws when the model cannot write it. */
export type ImageDescriber = (input: { question: string; images: readonly ImagePart[]; userId: string | null }) => Promise<string>;

export const modelDescribeImages: ImageDescriber = async ({ question, images, userId }) => {
  const generation = await generationForUser(userId, 'image_text');
  const { text } = await generateText({
    model: generation.model,
    instructions: IMAGE_TEXT_INSTRUCTIONS,
    messages: [withImages(imageTextPrompt(question, images.length), images)],
    maxOutputTokens: POST_IMAGE_TEXT_OUTPUT_TOKENS,
    temperature: 0,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(Math.max(generation.endpoint.timeoutMs, 30_000) * 2),
    ...visionOptions(images),
  });
  const cleaned = cleanImageText(text);
  if (!cleaned) throw new Error('empty image description');
  return cleaned;
};

/**
 * The post's `image_text`, written now when it has images and none yet.
 * Null without images; throws when the description cannot be written (the
 * caller decides whether that stops it). `images` saves a second read.
 */
export async function ensureImageText(postId: string, options: { images?: readonly ImagePart[]; describe?: ImageDescriber } = {}): Promise<string | null> {
  const [row] = await db().select({ question: post.question, detail: post.detail, imageText: post.imageText, userId: post.userId }).from(post).where(eq(post.id, postId)).limit(1);
  if (!row) return null;
  if (row.imageText) return row.imageText;
  const images = options.images ?? (await imageParts(postId));
  if (images.length === 0) return null;
  const text = await (options.describe ?? modelDescribeImages)({ question: [row.question, row.detail].filter(Boolean).join('\n'), images, userId: row.userId });
  await db().update(post).set({ imageText: text }).where(and(eq(post.id, postId), isNull(post.imageText)));
  return text;
}

/** Whether the post has images at all (cheap: no Blob read). */
export async function hasImages(postId: string): Promise<boolean> {
  const [row] = await db().select({ id: postImage.id }).from(postImage).where(eq(postImage.postId, postId)).limit(1);
  return Boolean(row);
}
