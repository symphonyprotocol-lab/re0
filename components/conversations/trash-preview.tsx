'use client';

import { useEffect, useState } from 'react';
import type { TrashPreviewMessage } from '@/lib/services/conversations';
import { useI18n } from '@/i18n/client';
import { Icon, Spinner } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';

/**
 * A conversation in the trash, read-only (prototype conversations.js
 * `cl-preview`): its last eight messages -- 我, the Ree's name, or
 * 已移除的 Ree -- with restore and immediate deletion actions.
 */
export function TrashPreview({ conversation, onClose, onRestore, onDelete }: { conversation: { id: string; title: string } | null; onClose: () => void; onRestore: (id: string) => void | Promise<void>; onDelete: (id: string) => void }) {
  const { t } = useI18n();
  const s = t.conversations.search;
  const [messages, setMessages] = useState<TrashPreviewMessage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const id = conversation?.id ?? null;

  useEffect(() => {
    setMessages(null);
    setFailed(false);
    if (!id) return;
    const controller = new AbortController();
    fetch(`/api/chats/${id}/preview`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        setMessages(((await response.json()) as { messages: TrashPreviewMessage[] }).messages);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [id]);

  return (
    <Modal
      open={Boolean(conversation)}
      onClose={onClose}
      title={conversation?.title ?? ''}
      subtitle={s.previewTitle}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t.common.actions.cancel}
          </button>
          <button type="button" className="btn-danger" onClick={() => id && onDelete(id)}>
            <Icon name="trash" className="size-4" />
            {s.deleteNow}
          </button>
          <button type="button" className="btn" onClick={() => id && onRestore(id)}>
            <Icon name="refresh" className="size-4" />
            {s.previewRestore}
          </button>
        </>
      }
    >
      {failed ? (
        <p className="text-[13px] text-muted">{t.common.errors.generic}</p>
      ) : messages === null ? (
        <span className="flex items-center gap-2 text-[12px] text-muted">
          <Spinner className="size-3.5" />
          {t.common.actions.loading}
        </span>
      ) : messages.length === 0 ? (
        <p className="text-[13px] text-muted">{s.previewEmpty}</p>
      ) : (
        <div className="conv-dialog cl-trash-preview">
          {messages.map((message) => (
            <article key={message.id}>
              <strong>{message.role === 'user' ? s.you : (message.reeName ?? t.conversations.room.removedRee)}</strong>
              <p>{message.content}</p>
            </article>
          ))}
        </div>
      )}
    </Modal>
  );
}
