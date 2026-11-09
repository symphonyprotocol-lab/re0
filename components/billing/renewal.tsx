'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { Spinner } from '@/components/ui/icons';

/**
 * "管理订阅" / "恢复续费" (prototype `manage-plan`): turning renewal off asks
 * first and says until when the period's credits stay; turning it back on
 * is immediate. Paddle is changed through `/api/billing/subscription`.
 */
export function RenewalControl({ cancelAtPeriodEnd, periodEndLabel }: { cancelAtPeriodEnd: boolean; periodEndLabel: string }) {
  const { t } = useI18n();
  const b = t.billing;
  const router = useRouter();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const change = async (action: 'cancel' | 'resume') => {
    setBusy(true);
    try {
      const response = await fetch('/api/billing/subscription', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: keyof typeof b.errors };
      if (!response.ok) {
        toast((body.error && b.errors[body.error]) || t.common.errors.generic);
        return;
      }
      toast(action === 'cancel' ? b.manage.cancelled : b.manage.resumed);
      setConfirming(false);
      router.refresh();
    } catch {
      toast(t.common.errors.network);
    } finally {
      setBusy(false);
    }
  };

  if (cancelAtPeriodEnd) {
    return (
      <button type="button" className="btn secondary" disabled={busy} onClick={() => change('resume')}>
        {busy && <Spinner />}
        {b.plan.resume}
      </button>
    );
  }
  return (
    <>
      <button type="button" className="btn secondary" onClick={() => setConfirming(true)}>
        {b.plan.manage}
      </button>
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={b.manage.title}
        footer={
          <>
            <button type="button" className="btn secondary" onClick={() => setConfirming(false)}>
              {b.manage.keep}
            </button>
            <button type="button" className="btn danger" disabled={busy} onClick={() => change('cancel')}>
              {busy && <Spinner />}
              {b.manage.confirm}
            </button>
          </>
        }
      >
        <p className="small muted">{fill(b.manage.body, { date: periodEndLabel })}</p>
      </Modal>
    </>
  );
}
