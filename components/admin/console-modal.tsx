'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/i18n/client';
import { CI } from '@/components/admin/console-icon';

/**
 * The console's dialogs in the prototype's markup (app.js `modal`:
 * `.overlay-backdrop > section.modal` with `.modal-head`, `.modal-body`,
 * `.modal-footer`), hosted in a native `<dialog>` so focus moves in and is
 * trapped, Escape closes, and focus returns to the opener. Like the
 * prototype's `#overlay-root`, it is portalled out of the page: to the end
 * of `.console-app`, so no table cell or `.console-content` rule reaches it.
 * Same props as components/ui/modal, so a console component only swaps the
 * import.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Kept for parity with components/ui/modal; the console's dialogs are all centred. */
  variant?: 'center' | 'drawer';
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => setHost(document.querySelector('.console-app')), []);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open, host]);
  if (!host) return null;
  return createPortal(
    <dialog
      ref={ref}
      className="console-dialog"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {open && (
        <div
          className="overlay-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <section className={`modal ${wide ? 'wide' : ''}`} aria-labelledby="dialog-title">
            <header className="modal-head">
              <div>
                <h2 id="dialog-title">{title}</h2>
                {subtitle && <p>{subtitle}</p>}
              </div>
              <button type="button" className="icon-btn" onClick={onClose} aria-label={t.common.actions.close} title={t.common.actions.close}>
                <CI name="close" />
              </button>
            </header>
            <div className="modal-body">{children}</div>
            {footer && <footer className="modal-footer">{footer}</footer>}
          </section>
        </div>
      )}
    </dialog>,
    host,
  );
}

/** A yes / no question (app.js `confirmModal`): the text as a form hint, cancel, then the action. */
export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn secondary" onClick={onClose}>
            {t.common.actions.cancel}
          </button>
          <button type="button" className={`btn ${danger ? 'danger' : ''}`} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="form-hint">{body}</div>
    </Modal>
  );
}
