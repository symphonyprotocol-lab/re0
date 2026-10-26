'use client';

import { useCallback, useId } from 'react';
import { SignInCard } from '@/components/site/sign-in-card';
import { XIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';

/**
 * The sign-in card as a modal, for a page that lets a visitor look before it
 * asks them to sign in -- the playground, at the moment they send.
 *
 * Native `<dialog>` for the same reasons as the console's (admin/console-dialog):
 * focus trap, Escape and inert background come with `showModal()`. It opens
 * itself as the element attaches, so the caller renders it only while it
 * should show. A click on the backdrop dismisses it too: there is nothing
 * typed inside it to lose.
 */
export function SignInDialog({
  returnTo,
  title,
  subtitle,
  closeLabel,
  onClose,
}: {
  /** Where the OAuth round trip brings the visitor back. */
  returnTo: string;
  title: string;
  subtitle: string;
  closeLabel: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const open = useCallback((node: HTMLDialogElement | null) => {
    if (node && !node.open) node.showModal();
  }, []);

  return (
    <dialog
      ref={open}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      className="m-auto w-[min(430px,calc(100vw-32px))] max-w-none overflow-visible border-0 bg-transparent p-0 backdrop:bg-ink/40"
    >
      <div className="relative">
        <button
          type="button"
          aria-label={closeLabel}
          onClick={(event) => event.currentTarget.closest('dialog')?.close()}
          className="absolute top-3 right-3 z-10 inline-flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-mutedbg hover:text-ink"
        >
          <XIcon size={16} />
        </button>
        <SignInCard
          copy={t.login}
          returnTo={returnTo}
          title={title}
          subtitle={subtitle}
          titleAs="h2"
          titleId={titleId}
        />
      </div>
    </dialog>
  );
}
