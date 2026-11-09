'use client';

import { useEffect, useState } from 'react';
import { CONVERSATION_TITLE_MAX } from '@/lib/constants';
import { useI18n } from '@/i18n/client';
import { Modal } from '@/components/ui/modal';
import '@/components/conversations/conversations.css';

/** "重命名对话": 1–120 characters. */
export function RenameDialog({ open, initial, onClose, onSave }: { open: boolean; initial: string; onClose: () => void; onSave: (title: string) => Promise<void> }) {
  const { t } = useI18n();
  const s = t.conversations.search;
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValue(initial);
      setError('');
    }
  }, [open, initial]);
  const submit = async () => {
    const title = value.replace(/\s+/g, ' ').trim();
    if (!title || Array.from(title).length > CONVERSATION_TITLE_MAX) return setError(s.renameInvalid);
    setBusy(true);
    try {
      await onSave(title);
    } catch {
      setError(t.common.errors.generic);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={s.renameTitle}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t.common.actions.cancel}
          </button>
          <button type="submit" form="conversation-rename-form" className="btn" disabled={busy}>
            {s.renameSave}
          </button>
        </>
      }
    >
      <form
        id="conversation-rename-form"
        className="conv-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <label htmlFor="conversation-rename">{s.renameLabel}</label>
          <input id="conversation-rename" value={value} maxLength={CONVERSATION_TITLE_MAX} required onChange={(event) => setValue(event.target.value)} autoFocus />
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
    </Modal>
  );
}
