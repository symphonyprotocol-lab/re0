'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';
import './modal.css';

/**
 * Dialogs and drawers on the native `<dialog>`: focus moves in and is trapped,
 * Escape closes, focus returns to the opener -- the browser does all three.
 * Markup and styles are the prototype's `.modal` / `.drawer` (./modal.css).
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  variant = 'center',
  wide = false,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  variant?: 'center' | 'drawer';
  wide?: boolean;
  /** False for a dialog whose content is shown once (a new API key): Escape and a click outside leave it open; its buttons still close it. */
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useI18n();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={open ? titleId : undefined}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(event) => {
        if (dismissible && event.target === ref.current) onClose();
      }}
      className={`modal${variant === 'drawer' ? ' drawer' : ''}${wide ? ' wide' : ''}`}
    >
      {open && (
        <>
          <header className="modal-head">
            <div>
              <h2 id={titleId}>{title}</h2>
              {subtitle && <p>{subtitle}</p>}
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label={t.common.actions.close} title={t.common.actions.close}>
              <Icon name="close" className="" />
            </button>
          </header>
          <div className="modal-body">{children}</div>
          {footer && <footer className="modal-footer">{footer}</footer>}
        </>
      )}
    </dialog>
  );
}

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
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t.common.actions.cancel}
          </button>
          <button type="button" className={danger ? 'btn-danger' : 'btn'} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed text-muted">{body}</div>
    </Modal>
  );
}
