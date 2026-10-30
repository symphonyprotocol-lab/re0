'use client';

import { put as putBlob } from '@vercel/blob/client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SpinnerIcon, UploadIcon } from '@/components/ui/icons';
import type { UploadTicket } from '@/lib/infrastructure/objects/store';

export type PrepareMedia = (input: {
  assetId: string;
  kind: 'image' | 'audio';
  name: string;
  size: number;
  contentType: string;
}) => Promise<{ ok: true; mediaId: string; ticket: UploadTicket; contentType: string } | { ok: false; error: string }>;

export type ConfirmMedia = (input: {
  mediaId: string;
  caption?: string;
  durationMs?: number | null;
}) => Promise<{ ok: true; mediaId: string } | { ok: false; error: string }>;

async function redeem(ticket: UploadTicket, file: File, contentType: string): Promise<boolean> {
  try {
    if (ticket.kind === 'put') {
      const response = await fetch(ticket.url, { method: 'PUT', body: file, headers: { 'content-type': contentType } });
      return response.ok;
    }
    await putBlob(ticket.pathname, file, { access: 'private', token: ticket.token, contentType });
    return true;
  } catch {
    return false;
  }
}

/** How long an audio file plays, read by the browser; null when it cannot tell. */
function audioDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : null);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    audio.src = url;
  });
}

/**
 * One file into the private bucket for an article or an episode
 * (agent-first-proposal.md 6.5, 6.6): a ticket from the server, the bytes
 * straight to the store, then the server confirms size, hash and capacity.
 * The failure is the message to show, already worded.
 */
export async function uploadMedia({
  assetId,
  kind,
  file,
  caption,
  prepare,
  confirm,
  errors,
  transfer,
}: {
  assetId: string;
  kind: 'image' | 'audio';
  file: File;
  caption?: string;
  prepare: PrepareMedia;
  confirm: ConfirmMedia;
  errors: Record<string, string>;
  /** What to say when the bytes did not reach the store. */
  transfer: string;
}): Promise<{ ok: true; mediaId: string } | { ok: false; message: string }> {
  const prepared = await prepare({ assetId, kind, name: file.name, size: file.size, contentType: file.type });
  if (!prepared.ok) return { ok: false, message: errors[prepared.error] ?? errors.unavailable ?? prepared.error };
  if (!(await redeem(prepared.ticket, file, prepared.contentType))) return { ok: false, message: transfer };
  const durationMs = kind === 'audio' ? await audioDuration(file) : null;
  const confirmed = await confirm({ mediaId: prepared.mediaId, caption, durationMs });
  if (!confirmed.ok) return { ok: false, message: errors[confirmed.error] ?? errors.unavailable ?? confirmed.error };
  return { ok: true, mediaId: confirmed.mediaId };
}

/**
 * A file picker and an upload button over `uploadMedia`, for audio: an
 * episode's file, or the note a Q&A answer takes. An article's images go in
 * through its editor's toolbar, paste and drop instead
 * (components/creator/markdown-editor.tsx).
 */
export function AudioUpload({
  assetId,
  accept,
  prepare,
  confirm,
  labels,
  errors,
}: {
  assetId: string;
  accept: string;
  prepare: PrepareMedia;
  confirm: ConfirmMedia;
  labels: { choose: string; upload: string; uploading: string; done: string; transfer: string };
  errors: Record<string, string>;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ good: boolean; text: string } | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const done = await uploadMedia({ assetId, kind: 'audio', file, prepare, confirm, errors, transfer: labels.transfer });
      if (!done.ok) {
        setMessage({ good: false, text: done.message });
        return;
      }
      setMessage({ good: true, text: labels.done });
      setFile(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="file"
          accept={accept}
          aria-label={labels.choose}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="text-[12px] text-steel file:mr-3 file:h-8 file:rounded-md file:border file:border-line file:bg-card file:px-3 file:text-[12px] file:text-steel"
        />
        <button
          type="button"
          onClick={upload}
          disabled={!file || busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-card px-3 text-[12px] font-medium text-steel hover:bg-subtle disabled:opacity-50"
        >
          {busy ? <SpinnerIcon size={13} /> : <UploadIcon size={13} />}
          {busy ? labels.uploading : labels.upload}
        </button>
      </div>
      {message ? (
        <p role="status" className={`text-[12px] ${message.good ? 'text-brandink' : 'text-rose'}`}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
