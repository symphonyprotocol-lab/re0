'use client';

import Link from 'next/link';
import { useState } from 'react';
import { KNOWLEDGE_URL_MAX, TEXT_SOURCE_LIMITS } from '@/lib/constants';
import { holdFor, KNOWLEDGE_KIND_LIST, validAudio, validDocument, validText, type KnowledgeKind } from '@/lib/domain/knowledge';
import { parseGithubRepo, parseWebUrl } from '@/lib/domain/sources';
import { api, uploadToBlob } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatBytes, formatNumber } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { errorText, KIND_ICONS } from '@/components/knowledge/shared';

/** What a new source would reserve, from what the form holds so far (8.2). */
export function estimateFor(kind: KnowledgeKind, input: { text?: string; bytes?: number }): number {
  if (kind === 'text') return input.text?.trim() ? holdFor('text', input.text) : 1;
  if (kind === 'audio') return holdFor('audio', input.bytes ?? 0);
  return holdFor(kind);
}

/** The error a link can fix, with where to fix it. */
export function FixLink({ code }: { code: string | undefined }) {
  const { t } = useI18n();
  if (code === 'insufficient_credits') {
    return (
      <Link href="/settings?tab=billing" className="font-semibold underline">
        {t.chat.insufficient.topUp}
      </Link>
    );
  }
  if (code === 'github_not_connected' || code === 'domain_unverified') {
    return (
      <Link href="/settings?tab=connections" className="font-semibold underline">
        {code === 'github_not_connected' ? t.knowledge.addModal.connect : t.knowledge.addModal.verify}
      </Link>
    );
  }
  return null;
}

/**
 * "给 Ree 一些知识。" -- the six kinds of 2.1: documents and audio go
 * straight to Blob and are then submitted, repositories, pages and websites
 * by URL, text as typed. The estimate is the reservation; the real price is
 * settled after processing. Opened inside a folder, the source lands there.
 */
export function AddKnowledgeModal({
  open,
  reeId,
  folder,
  onClose,
  onAdded,
}: {
  open: boolean;
  reeId: string;
  folder?: { id: string; name: string } | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t, locale } = useI18n();
  const m = t.knowledge.addModal;
  const [kind, setKind] = useState<KnowledgeKind>('document');
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<{ text: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const reset = () => {
    setFile(null);
    setConsent(false);
    setUrl('');
    setTitle('');
    setContent('');
    setError(null);
    setBusy(false);
    setProgress(null);
  };
  const close = () => {
    reset();
    onClose();
  };
  const choose = (next: KnowledgeKind) => {
    setKind(next);
    setFile(null);
    setError(null);
  };

  const fileKind = kind === 'document' || kind === 'audio';
  const urlKind = kind === 'github' || kind === 'page' || kind === 'site';
  const valid = kind === 'audio' ? validAudio : validDocument;

  const pick = (picked: File | undefined) => {
    if (!picked) return;
    const ok = valid(picked.name, picked.size);
    setError(ok ? null : { text: t.knowledge.errors[kind === 'audio' ? 'invalid_audio' : 'invalid_document'] });
    setFile(ok ? picked : null);
  };

  const submit = async () => {
    setError(null);
    let body: Record<string, unknown>;
    if (fileKind) {
      if (!file) return setError({ text: t.knowledge.errors[kind === 'audio' ? 'invalid_audio' : 'invalid_document'] });
      if (kind === 'audio' && !consent) return setError({ text: t.knowledge.errors.consent_required });
      setBusy(true);
      setProgress(0);
      const uploaded = await uploadToBlob(file, { purpose: kind, fileName: file.name, size: file.size }, setProgress);
      setProgress(null);
      if ('error' in uploaded) {
        setBusy(false);
        return setError({ text: t.reeSetup.messages.upload });
      }
      body = { kind, blobPath: uploaded.pathname, fileName: file.name, consent };
    } else if (urlKind) {
      const ok = kind === 'github' ? parseGithubRepo(url) : parseWebUrl(url);
      if (!ok) return setError({ text: t.knowledge.errors[kind === 'github' ? 'invalid_github_url' : 'invalid_url'] });
      setBusy(true);
      body = { kind, url: url.trim() };
    } else {
      if (!validText(title, content)) return setError({ text: t.knowledge.errors.invalid_text });
      setBusy(true);
      body = { kind: 'text', title, content };
    }
    const result = await api<{ id?: string; error?: string }>(`/api/rees/${reeId}/knowledge`, { method: 'POST', json: { ...body, folderId: folder?.id ?? null } });
    setBusy(false);
    if (result.ok) {
      reset();
      onAdded();
      return;
    }
    const code = result.status === 402 ? 'insufficient_credits' : result.data.error;
    setError({ text: errorText(t, code), code });
  };

  const estimate = estimateFor(kind, { text: content, bytes: file?.size });

  return (
    <Modal
      open={open}
      onClose={close}
      title={m.title}
      subtitle={folder ? fill(m.folder, { folder: folder.name }) : m.subtitle}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={close}>
            {t.common.actions.cancel}
          </button>
          <button type="button" className="btn" onClick={submit} disabled={busy}>
            {busy && <Spinner />}
            {progress !== null ? fill(m.uploading, { percent: progress }) : m.submit}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" role="radiogroup">
        {KNOWLEDGE_KIND_LIST.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={kind === value}
            onClick={() => choose(value)}
            className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-[11px] font-semibold ${
              kind === value ? 'border-blue bg-soft text-blue' : 'border-line text-muted hover:border-[#c4cce0]'
            }`}
          >
            <Icon name={KIND_ICONS[value]} />
            {m.kinds[value]}
          </button>
        ))}
      </div>

      {fileKind && (
        <>
          <label
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              pick(event.dataTransfer.files?.[0]);
            }}
            className={`mt-4 flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center ${dragging ? 'border-blue bg-soft' : 'border-line bg-wash'}`}
          >
            <Icon name={kind === 'audio' ? 'audio' : 'upload'} className="size-6 text-blue" />
            <strong className="max-w-full truncate text-[13px]">{file ? file.name : m.drop}</strong>
            <small className="text-[11px] text-muted">{file ? formatBytes(file.size) : m.limits[kind]}</small>
            <input
              type="file"
              className="sr-only"
              accept={kind === 'audio' ? '.mp3,.m4a,.wav' : '.pdf,.docx,.md,.txt'}
              onChange={(event) => {
                pick(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </label>
          {kind === 'audio' && (
            <label className="mt-3 flex items-start gap-2 text-[12px]">
              <input type="checkbox" className="mt-0.5" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              {m.consent}
            </label>
          )}
        </>
      )}

      {urlKind && (
        <label className="mt-4 block">
          <span className="field-label">{m.urlLabel[kind]}</span>
          <input className="input" type="url" inputMode="url" maxLength={KNOWLEDGE_URL_MAX} value={url} placeholder={m.urlPlaceholder[kind]} onChange={(event) => setUrl(event.target.value)} />
          <small className="hint">{m.urlHint[kind]}</small>
        </label>
      )}

      {kind === 'text' && (
        <div className="mt-4 flex flex-col gap-4">
          <label>
            <span className="field-label">{m.title_}</span>
            <input className="input" maxLength={TEXT_SOURCE_LIMITS.title} value={title} placeholder={m.titlePlaceholder} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            <span className="field-label flex justify-between">
              {m.content}
              <span className="font-mono text-[10px] font-normal text-muted">
                {content.length} / {TEXT_SOURCE_LIMITS.content}
              </span>
            </span>
            <textarea
              className="input min-h-[150px] resize-y"
              rows={6}
              maxLength={TEXT_SOURCE_LIMITS.content}
              value={content}
              placeholder={m.contentPlaceholder}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between rounded-lg border border-line bg-wash px-3 py-2.5 text-[12px]">
        <span className="text-muted">{m.estimate}</span>
        <strong className="font-mono">{fill(m.estimateValue, { credits: formatNumber(estimate, locale) })}</strong>
      </div>
      <p className="mt-2 text-[11px] text-muted">{m.note}</p>
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">
          {error.text} <FixLink code={error.code} />
        </p>
      )}
    </Modal>
  );
}
