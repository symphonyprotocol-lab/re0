/**
 * Uploaded Markdown and MDX files, read back from object storage.
 *
 * The PDF connector's shape (`pdf.ts`) with the extraction taken out: the
 * wizard put the files in the bucket before the asset existed, the source
 * row's config says where, and each is handed to the pipeline as the text it
 * already is, named as the operator named it -- the `.md` / `.mdx` extension
 * is what tells the parse step the format (`documentFormat`), so the name
 * is kept whole.
 *
 * Bytes are decoded as UTF-8. A file that is not valid UTF-8 is still
 * decoded, with replacement characters, rather than refused: an operator's
 * one mis-encoded README should not fail the build of the other forty.
 */
import { EMPTY_SOURCE_CONFIG, IngestionFailure } from '@/lib/domain/ingestion';
import { uploadedFilesOf, type UploadedFile } from '@/lib/domain/asset';
import type { ObjectStore } from '@/lib/infrastructure/objects/store';
import type { FetchedFile, SourceSnapshot } from './types';

/** Reads run this many at a time; the store is one request per key. */
const READ_CONCURRENCY = 4;

const decoder = new TextDecoder('utf-8');

export async function fetchMarkdownSnapshot(input: {
  config: Record<string, unknown>;
  store: Pick<ObjectStore, 'get'>;
}): Promise<SourceSnapshot> {
  const uploads = uploadedFilesOf(input.config);
  if (uploads.length === 0) {
    throw new IngestionFailure('source_empty', 'fetch-snapshot', 'the source lists no files');
  }

  const files: FetchedFile[] = [];
  for (let at = 0; at < uploads.length; at += READ_CONCURRENCY) {
    const batch = await Promise.all(
      uploads.slice(at, at + READ_CONCURRENCY).map((upload) => readOne(upload, input.store)),
    );
    files.push(...batch);
  }

  return {
    files,
    config: EMPTY_SOURCE_CONFIG,
    revision: null,
    lastModifiedAt: null,
    hasLicense: false,
    stale: false,
  };
}

async function readOne(upload: UploadedFile, store: Pick<ObjectStore, 'get'>): Promise<FetchedFile> {
  let bytes: Uint8Array | null;
  try {
    bytes = await store.get(upload.key);
  } catch (error) {
    throw new IngestionFailure(
      'storage_unavailable',
      'fetch-snapshot',
      `could not read ${upload.name}: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
  if (!bytes) {
    throw new IngestionFailure(
      'source_unreachable',
      'fetch-snapshot',
      `${upload.name} is no longer in storage`,
    );
  }

  return {
    path: upload.name,
    /* Served by the dashboard for the owning workspace, which resolves the
       file by its own id (app/dashboard/files/[fileId]). */
    url: `/dashboard/files/${upload.id}`,
    content: decoder.decode(bytes).replace(/^﻿/, ''),
    format: 'markdown',
  };
}
