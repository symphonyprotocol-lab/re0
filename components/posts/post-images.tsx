'use client';

import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { fitWithin, isPostImageType, pastedImages, POST_IMAGE_EDGE, POST_IMAGE_MAX, POST_IMAGE_MAX_BYTES, POST_IMAGE_TYPES, POST_IMAGE_UPLOAD_MAX_BYTES } from '@/lib/domain/post-images';
import { uploadToBlob } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';

const MB = POST_IMAGE_MAX_BYTES / 1024 / 1024;

/**
 * The image as it is stored and sent to models: scaled so its longest edge
 * is at most `POST_IMAGE_EDGE`, re-encoded as JPEG (on white, for
 * transparent PNGs) at falling quality until it fits
 * `POST_IMAGE_UPLOAD_MAX_BYTES`. A file already that small and that size is
 * kept as it is. Throws when the browser cannot decode it or it never fits.
 */
async function preparedImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const size = fitWithin(bitmap.width, bitmap.height, POST_IMAGE_EDGE);
    if (size.width === bitmap.width && size.height === bitmap.height && file.size <= POST_IMAGE_UPLOAD_MAX_BYTES) return file;
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no canvas');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    for (const quality of [0.85, 0.72, 0.6, 0.5]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= POST_IMAGE_UPLOAD_MAX_BYTES) return blob;
    }
    throw new Error('image too large after scaling');
  } finally {
    bitmap.close();
  }
}

interface Attachment {
  key: string;
  /** The file in the browser, shown until the post exists (`/media` serves an image only once a post names it). */
  preview: string;
  state: 'uploading' | 'done' | 'failed';
  pathname: string | null;
}

/**
 * A post's images while it is being written (lib/domain/post-images.ts):
 * each file is checked here (type, size, count), uploaded straight to Blob
 * with a token from `/api/upload-token`, and previewed from the file itself.
 * `pathnames` is what the publish sends; `ready` is false while any upload
 * runs or failed.
 */
export function usePostImages() {
  const { t } = useI18n();
  const c = t.posts.composer;
  const [items, setItems] = useState<Attachment[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const live = useRef(items);
  live.current = items;
  /* Previews are object URLs: given back when an image goes and when the form does. */
  useEffect(() => () => live.current.forEach((item) => URL.revokeObjectURL(item.preview)), []);

  const add = useCallback(
    (files: readonly File[]) => {
      setProblem(null);
      const room = POST_IMAGE_MAX - live.current.length;
      if (files.length > room) setProblem(fill(c.imageLimit, { max: POST_IMAGE_MAX }));
      for (const file of files.slice(0, Math.max(room, 0))) {
        if (!isPostImageType(file.type)) {
          setProblem(c.imageType);
          continue;
        }
        if (file.size <= 0 || file.size > POST_IMAGE_MAX_BYTES) {
          setProblem(fill(c.imageSize, { mb: MB }));
          continue;
        }
        const key = crypto.randomUUID();
        const preview = URL.createObjectURL(file);
        setItems((current) => [...current, { key, preview, state: 'uploading', pathname: null }]);
        void preparedImage(file)
          .then((image) => uploadToBlob(image, { purpose: 'post-image', contentType: image.type, size: image.size }))
          .catch(() => ({ error: 'prepare' }))
          .then((result) => {
            setItems((current) => current.map((item) => (item.key !== key ? item : 'pathname' in result ? { ...item, state: 'done', pathname: result.pathname } : { ...item, state: 'failed' })));
          });
      }
    },
    [c],
  );

  const remove = useCallback((key: string) => {
    setProblem(null);
    setItems((current) => {
      const gone = current.find((item) => item.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return current.filter((item) => item.key !== key);
    });
  }, []);

  const clear = useCallback(() => {
    live.current.forEach((item) => URL.revokeObjectURL(item.preview));
    setItems([]);
    setProblem(null);
  }, []);

  /** Images pasted into the question or the detail join the post; a paste that carries text (cells copied from a spreadsheet) stays text. */
  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const data = event.clipboardData;
      const files = pastedImages({ types: Array.from(data.types), files: data.files }).map((index) => data.files[index]!);
      if (files.length === 0) return;
      event.preventDefault();
      add(files);
    },
    [add],
  );

  const uploading = items.some((item) => item.state === 'uploading');
  const failed = items.some((item) => item.state === 'failed');
  return {
    items,
    add,
    remove,
    clear,
    onPaste,
    uploading,
    failed,
    ready: !uploading && !failed,
    pathnames: items.flatMap((item) => (item.pathname ? [item.pathname] : [])),
    /** What the form says about its images now: a refused file, a failed upload, or uploads still running. */
    notice: problem ?? (failed ? c.imageFailed : null),
  };
}

export type PostImagesState = ReturnType<typeof usePostImages>;

/** The 图片 button beside 补充说明: opens the file picker. */
export function ImageButton({ images, disabled = false }: { images: PostImagesState; disabled?: boolean }) {
  const { t } = useI18n();
  const c = t.posts.composer;
  const input = useRef<HTMLInputElement>(null);
  const full = images.items.length >= POST_IMAGE_MAX;
  return (
    <>
      <button type="button" className="icon-btn" disabled={disabled || full} title={fill(c.addImageTitle, { max: POST_IMAGE_MAX, mb: MB })} onClick={() => input.current?.click()}>
        <Icon name="image" className="size-3.5" />
        {c.addImage}
        {images.items.length > 0 && <small>{images.items.length}/{POST_IMAGE_MAX}</small>}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept={Object.keys(POST_IMAGE_TYPES).join(',')}
        onChange={(event) => {
          images.add(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
    </>
  );
}

/** The chosen images as thumbnails, each removable, with its upload state. */
export function ImageTray({ images }: { images: PostImagesState }) {
  const { t } = useI18n();
  const c = t.posts.composer;
  if (images.items.length === 0 && !images.notice) return null;
  return (
    <div className="post-image-tray">
      {images.items.length > 0 && (
        <ul>
          {images.items.map((item, index) => (
            <li key={item.key} className={`is-${item.state}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL, not an optimisable asset */}
              <img src={item.preview} alt={fill(t.posts.images.alt, { n: index + 1 })} />
              {item.state === 'uploading' && <i className="spinner" aria-label={c.imageUploading} />}
              {item.state === 'failed' && <Icon name="info" className="post-image-failed" />}
              <button type="button" aria-label={c.removeImage} title={c.removeImage} onClick={() => images.remove(item.key)}>
                <Icon name="close" className="" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {images.notice ? (
        <p className="post-error" role="alert">
          {images.notice}
        </p>
      ) : (
        <p className="post-hint">{images.uploading ? c.imageUploading : c.imageHint}</p>
      )}
    </div>
  );
}

/** A post's images on its page: a grid of thumbnails, each opening the full image. */
export function PostImageGallery({ images }: { images: readonly { url: string }[] }) {
  const { t } = useI18n();
  if (images.length === 0) return null;
  return (
    <div className={`post-image-gallery n-${images.length}`}>
      {images.map((image, index) => (
        <a key={image.url} href={image.url} target="_blank" rel="noopener" title={t.posts.images.open}>
          {/* eslint-disable-next-line @next/next/no-img-element -- private media, served per viewer */}
          <img src={image.url} alt={fill(t.posts.images.alt, { n: index + 1 })} loading="lazy" />
        </a>
      ))}
    </div>
  );
}

/** A card's thumbnail: the first image, with how many there are. */
export function PostImageThumb({ images }: { images: readonly { url: string }[] }) {
  const { t } = useI18n();
  if (images.length === 0) return null;
  return (
    <span className="post-image-thumb" title={fill(t.posts.images.count, { n: images.length })}>
      {/* eslint-disable-next-line @next/next/no-img-element -- private media, served per viewer */}
      <img src={images[0]!.url} alt={fill(t.posts.images.alt, { n: 1 })} loading="lazy" />
      {images.length > 1 && <small>{images.length}</small>}
    </span>
  );
}
