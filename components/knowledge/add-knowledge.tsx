'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { TEXT_SOURCE_LIMITS } from '@/lib/constants';
import { holdFor, validDocument, validText } from '@/lib/domain/knowledge';
import { api, uploadToBlob } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatBytes } from '@/i18n/format';
import { Icon, Spinner } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';

/**
 * "给 Ree 一些知识。" -- documents (straight to Blob, then submitted) and
 * pasted text in step 1; the other four kinds are shown but open in step 2.
 * The estimate is the reservation; the real price is settled after processing.
 */
export function AddKnowledgeModal({ open, reeId, onClose, onAdded }: { open: boolean; reeId: string; onClose: () => void; onAdded: () => void }) {
  const { t } = useI18n();
  const m = t.knowledge.addModal;
  const [kind, setKind] = useState<'document' | 'text'>('document');
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<{ text: string; billing?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setTitle('');
    setContent('');
    setError(null);
    setBusy(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const pick = (picked: File | undefined) => {
    if (!picked) return;
    setError(validDocument(picked.name, picked.size) ? null : { text: t.knowledge.errors.invalid_document });
    setFile(validDocument(picked.name, picked.size) ? picked : null);
  };

  const submit = async () => {
    setError(null);
    let body: Record<string, unknown>;
    if (kind === 'document') {
      if (!file) return setError({ text: t.knowledge.errors.invalid_document });
      setBusy(true);
      const uploaded = await uploadToBlob(file, { purpose: 'document', fileName: file.name, size: file.size });
      if ('error' in uploaded) {
        setBusy(false);
        return setError({ text: t.reeSetup.messages.upload });
      }
      body = { kind: 'document', blobPath: uploaded.pathname, fileName: file.name };
    } else {
      if (!validText(title, content)) return setError({ text: t.knowledge.errors.invalid_text });
      setBusy(true);
      body = { kind: 'text', title, content };
    }
    const result = await api<{ id?: string; error?: string }>(`/api/rees/${reeId}/knowledge`, { method: 'POST', json: body });
    setBusy(false);
    if (result.ok) {
      reset();
      onAdded();
      return;
    }
    const code = result.data.error as keyof typeof t.knowledge.errors | undefined;
    setError({ text: code && code in t.knowledge.errors ? t.knowledge.errors[code] : t.common.errors.generic, billing: result.status === 402 });
  };

  const estimate = kind === 'text' ? (content.trim() ? holdFor('text', content) : 1) : holdFor('document');

  return (
    <Modal
      open={open}
      onClose={close}
      title={m.title}
      subtitle={m.subtitle}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={close}>
            {t.common.actions.cancel}
          </button>
          <button type="button" className="btn" onClick={submit} disabled={busy}>
            {busy && <Spinner />}
            {busy && kind === 'document' ? m.uploading : m.submit}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {(['document', 'text', 'audio', 'github', 'page', 'site'] as const).map((value) => {
          const enabled = value === 'document' || value === 'text';
          return (
            <button
              key={value}
              type="button"
              disabled={!enabled}
              aria-pressed={kind === value}
              onClick={() => enabled && setKind(value)}
              className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-[11px] font-semibold disabled:opacity-40 ${
                kind === value ? 'border-blue bg-soft text-blue' : 'border-line text-muted hover:border-[#c4cce0]'
              }`}
            >
              <Icon name={value === 'text' ? 'text' : value === 'github' ? 'github' : value === 'page' || value === 'site' ? 'globe' : 'file'} />
              {value === 'document' || value === 'text' ? m.kinds[value] : t.common.kinds[value]}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted">{m.later}</p>

      {kind === 'document' ? (
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
          <Icon name="upload" className="size-6 text-blue" />
          <strong className="text-[13px]">{file ? file.name : m.drop}</strong>
          <small className="text-[11px] text-muted">{file ? formatBytes(file.size) : m.limits}</small>
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            accept=".pdf,.docx,.md,.txt"
            onChange={(event) => {
              pick(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </label>
      ) : (
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
        <strong className="font-mono">{fill(m.estimateValue, { credits: estimate })}</strong>
      </div>
      <p className="mt-2 text-[11px] text-muted">{m.note}</p>
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">
          {error.text}{' '}
          {error.billing && (
            <Link href="/settings?tab=billing" className="font-semibold underline">
              {t.chat.insufficient.topUp}
            </Link>
          )}
        </p>
      )}
    </Modal>
  );
}
