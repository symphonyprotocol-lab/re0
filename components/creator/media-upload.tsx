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
 * An image's reference is appended to the editor's body field as
 * `![caption](media:<id>)`.
 */
export function MediaUpload({
  assetId,
  kind,
  accept,
  targetId,
  prepare,
  confirm,
  labels,
  errors,
}: {
  assetId: string;
  kind: 'image' | 'audio';
  accept: string;
  /** The textarea an uploaded image's reference is appended to. */
  targetId?: string;
  prepare: PrepareMedia;
  confirm: ConfirmMedia;
  labels: { choose: string; caption: string; upload: string; uploading: string; done: string; transfer: string };
  errors: Record<string, string>;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ good: boolean; text: string } | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const prepared = await prepare({ assetId, kind, name: file.name, size: file.size, contentType: file.type });
      if (!prepared.ok) {
        setMessage({ good: false, text: errors[prepared.error] ?? errors.unavailable ?? prepared.error });
        return;
      }
      if (!(await redeem(prepared.ticket, file, prepared.contentType))) {
        setMessage({ good: false, text: labels.transfer });
        return;
      }
      const durationMs = kind === 'audio' ? await audioDuration(file) : null;
      const confirmed = await confirm({ mediaId: prepared.mediaId, caption, durationMs });
      if (!confirmed.ok) {
        setMessage({ good: false, text: errors[confirmed.error] ?? errors.unavailable ?? confirmed.error });
        return;
      }
      if (kind === 'image' && targetId) {
        const target = document.getElementById(targetId) as HTMLTextAreaElement | null;
        if (target) target.value = `${target.value.replace(/\s*$/, '')}\n\n![${caption.replace(/[\]\n]/g, ' ')}](media:${confirmed.mediaId})\n`;
      }
      setMessage({ good: true, text: labels.done });
      setFile(null);
      setCaption('');
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
        {kind === 'image' ? (
          <input
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            maxLength={300}
            placeholder={labels.caption}
            className="h-8 min-w-[200px] flex-1 rounded-md border border-line bg-field px-2.5 text-[12px] text-ink"
          />
        ) : null}
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
