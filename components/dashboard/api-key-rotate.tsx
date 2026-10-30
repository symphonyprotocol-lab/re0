'use client';

import { useRouter } from 'next/navigation';
import { useActionState } from 'react';
import { submitOn } from '@/components/admin/platform-asset-shared';
import { CopyButton } from '@/components/dashboard/copy-button';
import { PANEL } from '@/components/dashboard/ui';
import type { RotateKeyResult } from '@/app/dashboard/api-keys/actions';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * Rotate one key. requirement.md 5.2: the replacement keeps the name,
 * environment and scopes; the old key dies in the same transaction. The new
 * plaintext is shown once, in an overlay that survives until the user says
 * they have it -- only then is the list refreshed, because the refreshed list
 * no longer holds this row.
 */
export function ApiKeyRotate({
  keyId,
  name,
  action,
}: {
  keyId: string;
  name: string;
  action: (previous: RotateKeyResult | null, form: FormData) => Promise<RotateKeyResult>;
}) {
  const { t } = useI18n();
  const k = t.dashboard.apiKeys;
  const s = k.scoped;
  const router = useRouter();
  const [state, formAction, pending] = useActionState(action, null);
  const submit = submitOn(formAction);

  return (
    <>
      <form
        onSubmit={(event) => {
          if (!window.confirm(s.rotateConfirm)) {
            event.preventDefault();
            return;
          }
          submit(event);
        }}
      >
        <input type="hidden" name="keyId" value={keyId} />
        <button
          type="submit"
          disabled={pending}
          aria-label={fill(s.rotate, { name })}
          title={fill(s.rotate, { name })}
          className="inline-flex size-[26px] items-center justify-center rounded-md text-muted transition-colors hover:bg-mutedbg hover:text-brandink disabled:opacity-50"
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            width={15}
            height={15}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>
      </form>

      {state && !state.ok ? (
        <span role="alert" className="sr-only">
          {s.rotateFailed}
        </span>
      ) : null}

      {state?.ok && state.key ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={s.rotatedTitle}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
        >
          <div className={`${PANEL} flex w-full max-w-[520px] flex-col gap-3 p-[22px]`}>
            <p className="text-[15px] font-medium text-ink">
              {s.rotatedTitle} · {state.name}
            </p>
            <p className="text-[12px] leading-[1.6] text-muted">
              {s.rotatedBody}
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-publine bg-pubsoft/40 p-3">
              <code className="min-w-0 flex-1 truncate rounded-md bg-card px-2 py-1.5 font-mono text-[11.5px] text-steel">
                {state.key}
              </code>
              <CopyButton
                value={state.key}
                label={k.create.copy}
                className="text-steel hover:bg-mutedbg"
              />
            </div>
            <button
              type="button"
              onClick={() => router.refresh()}
              className="h-9 self-end rounded-md bg-brand px-4 text-[12px] font-medium text-white transition-colors hover:bg-brand/90"
            >
              {s.rotateDone}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
