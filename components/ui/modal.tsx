'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';

/**
 * Dialogs and drawers on the native `<dialog>`: focus moves in and is trapped,
 * Escape closes, focus returns to the opener -- the browser does all three.
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
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  variant?: 'center' | 'drawer';
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const placement =
    variant === 'drawer'
      ? 'm-0 ml-auto h-dvh max-h-dvh w-full max-w-[460px] rounded-none sm:rounded-l-2xl'
      : `m-auto w-[calc(100%-32px)] ${wide ? 'max-w-[760px]' : 'max-w-[520px]'} max-h-[calc(100dvh-32px)] rounded-2xl`;
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={`${placement} border border-line bg-white p-0 text-ink shadow-2xl backdrop:bg-ink/30 backdrop:backdrop-blur-[2px]`}
    >
      {open && (
        <div className="flex max-h-[inherit] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
            <div className="min-w-0">
              <h2 className="text-[17px] font-bold">{title}</h2>
              {subtitle && <p className="mt-1 text-[12px] text-muted">{subtitle}</p>}
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label={t.common.actions.close}>
              <Icon name="close" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer && <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-6 py-4">{footer}</footer>}
        </div>
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
