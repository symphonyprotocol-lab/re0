'use client';

import { put as putBlob } from '@vercel/blob/client';
import { useCallback, useRef, useState } from 'react';
import { FileTextIcon, SpinnerIcon, UploadIcon, XIcon } from '@/components/ui/icons';
import type { PrepareUploadResult } from '@/app/dashboard/assets/new/actions';
import type { UploadTicket } from '@/lib/infrastructure/objects/store';
import {
  UPLOAD_CONTENT_TYPES,
  UPLOAD_EXTENSIONS,
  UPLOAD_LIMITS,
  type UploadSourceType,
} from '@/lib/domain/asset';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * Picking PDFs -- or Markdown/MDX files, when `kind` says so -- and getting
 * them into the store, shared by the import wizard and the asset files
 * page.
 *
 * The browser redeems the ticket the prepare action hands back -- a presigned
 * PUT for an S3 bucket, a scoped client token for Vercel Blob -- so a file
 * never goes through a server action; what the form finally posts is the
 * manifest of ids, names and sizes, which the use case confirms against the
 * store before a row changes.
 */

export interface Upload {
  id: string;
  name: string;
  size: number;
  status: 'uploading' | 'done' | 'failed';
}

export type PrepareUploads = (
  files: { name: string; size: number }[],
  batchId?: string,
  kind?: UploadSourceType,
) => Promise<PrepareUploadResult>;

export type UploadError = PrepareUploadResult['error'] | 'transfer';

async function redeem(ticket: UploadTicket, file: File, contentType: string): Promise<boolean> {
  try {
    if (ticket.kind === 'put') {
      const response = await fetch(ticket.url, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': contentType },
      });
      return response.ok;
    }
    await putBlob(ticket.pathname, file, {
      access: 'private',
      token: ticket.token,
      contentType,
    });
    return true;
  } catch {
    return false;
  }
}

export function formatBytes(size: number): string {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

/** Whether a picked file is of the kind being uploaded, by extension or by type. */
export function acceptsUpload(file: { name: string; type: string }, kind: UploadSourceType): boolean {
  const lower = file.name.toLowerCase();
  return (
    UPLOAD_EXTENSIONS[kind].some((extension) => lower.endsWith(`.${extension}`)) ||
    file.type === UPLOAD_CONTENT_TYPES[kind]
  );
}

/** The `accept` attribute of the picker for one kind. */
export function uploadAccept(kind: UploadSourceType): string {
  return [UPLOAD_CONTENT_TYPES[kind], ...UPLOAD_EXTENSIONS[kind].map((extension) => `.${extension}`)].join(',');
}

/**
 * The upload state behind one batch. `room` is how many more files may be
 * added -- the wizard's whole allowance, or what an asset has left; `kind`
 * is what is being uploaded, PDFs unless said otherwise.
 */
export function usePdfUploads(
  prepare: PrepareUploads,
  room: number = UPLOAD_LIMITS.maxFiles,
  kind: UploadSourceType = 'pdf',
) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [error, setError] = useState<UploadError | null>(null);

  const uploaded = uploads.filter((upload) => upload.status === 'done');
  const settled = uploads.every((upload) => upload.status !== 'uploading');

  async function pick(list: FileList | null) {
    const files = Array.from(list ?? []).filter((file) => acceptsUpload(file, kind));
    if (files.length === 0) return;
    setError(null);
    if (uploads.length + files.length > room) {
      setError('invalid');
      return;
    }
    if (files.some((file) => file.size > UPLOAD_LIMITS.maxFileBytes)) {
      setError('too_large');
      return;
    }

    const prepared = await prepare(
      files.map((file) => ({ name: file.name, size: file.size })),
      batchId ?? undefined,
      kind,
    );
    if (!prepared.ok || !prepared.files || !prepared.batchId) {
      setError(prepared.error ?? 'unavailable');
      return;
    }
    setBatchId(prepared.batchId);
    const slots = prepared.files;
    setUploads((current) => [
      ...current,
      ...slots.map((slot) => ({ id: slot.id, name: slot.name, size: slot.size, status: 'uploading' as const })),
    ]);

    await Promise.all(
      slots.map(async (slot, index) => {
        const file = files[index];
        const ok = file ? await redeem(slot.ticket, file, UPLOAD_CONTENT_TYPES[kind]) : false;
        setUploads((current) =>
          current.map((upload) =>
            upload.id === slot.id ? { ...upload, status: ok ? 'done' : 'failed' } : upload,
          ),
        );
        if (!ok) setError('transfer');
      }),
    );
  }

  const remove = useCallback((id: string) => {
    setUploads((current) => current.filter((entry) => entry.id !== id));
  }, []);

  /* Stable, so a caller may put it in an effect's dependencies. */
  const reset = useCallback(() => {
    setUploads([]);
    setBatchId(null);
    setError(null);
  }, []);

  /** What the form posts: only the files that landed. Empty until one has. */
  const manifest =
    batchId && uploaded.length > 0
      ? JSON.stringify({
          batchId,
          files: uploaded.map(({ id, name, size }) => ({ id, name, size })),
        })
      : '';

  return { uploads, uploaded, settled, error, manifest, pick, remove, reset, kind };
}

/**
 * The picker and the list of files on their way. Not a `<label>`: a click
 * anywhere in a label -- the remove button included -- activates the file
 * input nested in it and opens the picker.
 */
export function PdfUploadField({
  state,
  label,
  hint,
  room = UPLOAD_LIMITS.maxFiles,
}: {
  state: ReturnType<typeof usePdfUploads>;
  label: string;
  hint: string;
  room?: number;
}) {
  const { t } = useI18n();
  const w = t.dashboard.newAsset.wizard;
  const md = t.dashboard.newAsset.markdown;
  const picker = useRef<HTMLInputElement>(null);
  const isMarkdown = state.kind === 'markdown';

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-steel">{label}</span>
      <input
        ref={picker}
        type="file"
        accept={uploadAccept(state.kind)}
        multiple
        hidden
        onChange={(event) => {
          const files = event.target.files;
          if (picker.current) picker.current.value = '';
          void state.pick(files);
        }}
      />
      <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-line bg-card p-2.5">
        {state.uploads.map((upload) => (
          <div
            key={upload.id}
            className="flex items-center gap-2 rounded-md bg-subtle px-2.5 py-1.5 text-[12px]"
          >
            {upload.status === 'uploading' ? <SpinnerIcon size={14} /> : <FileTextIcon size={14} />}
            <span className="min-w-0 flex-1 truncate text-ink">{upload.name}</span>
            <span className="shrink-0 text-muted">
              {upload.status === 'failed' ? w.fileFailed : formatBytes(upload.size)}
            </span>
            <button
              type="button"
              aria-label={w.fileRemove}
              disabled={upload.status === 'uploading'}
              onClick={() => state.remove(upload.id)}
              className="shrink-0 text-muted hover:text-ink disabled:opacity-40"
            >
              <XIcon size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => picker.current?.click()}
          disabled={state.uploads.length >= room}
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md text-[12px] text-steel transition-colors hover:bg-subtle disabled:opacity-40"
        >
          <UploadIcon size={14} />
          {state.uploads.length === 0
            ? isMarkdown
              ? md.filesPick
              : w.filesPick
            : isMarkdown
              ? md.filesPickMore
              : w.filesPickMore}
        </button>
      </div>
      {state.error ? (
        <span className="text-[11px] text-rose">
          {state.error === 'too_large'
            ? fill(w.errorFileTooLarge, { size: formatBytes(UPLOAD_LIMITS.maxFileBytes) })
            : state.error === 'invalid'
              ? fill(w.errorFileCount, { max: String(UPLOAD_LIMITS.maxFiles) })
              : state.error === 'access_denied'
                ? w.errorUploadDenied
                : state.error === 'transfer'
                  ? w.errorUploadFailed
                  : w.errorUploadUnavailable}
        </span>
      ) : null}
      <span className="text-[10px] text-muted">{hint}</span>
    </div>
  );
}
