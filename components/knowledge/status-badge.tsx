'use client';

import type { Messages } from '@/i18n';
import { useI18n } from '@/i18n/client';
import { Spinner } from '@/components/ui/icons';

const STYLES: Record<string, string> = {
  ready: 'bg-[#e9f6f1] text-green',
  pending: 'bg-soft text-blue',
  processing: 'bg-soft text-blue',
  failed: 'bg-[#fff3f3] text-red',
};

export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const busy = status === 'pending' || status === 'processing';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${STYLES[status] ?? ''}`}>
      {busy ? <Spinner className="size-2.5" /> : <i className="size-1.5 rounded-full bg-current" />}
      {t.common.status[status as keyof typeof t.common.status] ?? status}
    </span>
  );
}

export function failureLabel(t: Messages, code: string | null): string {
  const failures = t.knowledge.failures;
  return code && code in failures ? failures[code as keyof typeof failures] : failures.unknown;
}
