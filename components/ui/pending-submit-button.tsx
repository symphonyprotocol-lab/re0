'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowRightIcon, SpinnerIcon } from '@/components/ui/icons';

/**
 * Submit button for a form whose action leaves the page -- the checkout and
 * billing portal forms, whose server action ends in a redirect to the
 * provider. The trailing arrow turns into a spinner while the action runs, and
 * the button is disabled so a double-click cannot create two transactions.
 *
 * The pending state is taken from the form's own submit event rather than
 * `useFormStatus`: the action never resolves on this page (it redirects away),
 * so React's status would still read pending when the visitor comes back
 * through the back/forward cache. `pageshow` resets it, the same approach as
 * `site/provider-sign-in-button`.
 */
export function PendingSubmitButton({
  className,
  children,
  arrow = true,
}: {
  className: string;
  children: ReactNode;
  /** Whether the idle state ends in an arrow; the spinner replaces it either way. */
  arrow?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;

    const onSubmit = () => setPending(true);
    const onPageShow = () => setPending(false);

    form.addEventListener('submit', onSubmit);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      form.removeEventListener('submit', onSubmit);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  return (
    <button
      ref={ref}
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={`${className} disabled:cursor-progress disabled:opacity-70`}
    >
      {children}
      {pending ? (
        /* Static ring under reduced motion; the cursor still reads as busy. */
        <SpinnerIcon size={14} className="motion-safe:animate-spin" />
      ) : arrow ? (
        <ArrowRightIcon size={14} />
      ) : null}
    </button>
  );
}
