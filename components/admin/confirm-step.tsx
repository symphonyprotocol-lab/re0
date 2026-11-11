'use client';

import { useState } from 'react';
import { ConfirmModal } from '@/components/admin/console-modal';

/** One final decision waiting for its confirmation: what it does, in words that name the amount and the person. */
export interface ConfirmStep {
  title: string;
  body: string;
  label: string;
  danger?: boolean;
  run: () => Promise<void> | void;
}

/**
 * A confirmation before a console decision that cannot be undone (review C8):
 * `ask(step)` opens it, the confirm button runs `step.run` once (it stays
 * disabled while that runs), and the dialog closes after. The decision's own
 * error, if any, shows in its form as before.
 */
export function useConfirmStep(): { ask: (step: ConfirmStep) => void; dialog: React.ReactNode } {
  const [step, setStep] = useState<ConfirmStep | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = (
    <ConfirmModal
      open={step !== null}
      title={step?.title ?? ''}
      body={step?.body ?? ''}
      confirmLabel={step?.label ?? ''}
      danger={step?.danger}
      busy={busy}
      onClose={() => {
        if (!busy) setStep(null);
      }}
      onConfirm={async () => {
        if (!step || busy) return;
        setBusy(true);
        try {
          await step.run();
        } finally {
          setBusy(false);
          setStep(null);
        }
      }}
    />
  );
  return { ask: setStep, dialog };
}
