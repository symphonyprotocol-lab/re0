'use client';

import type { Messages } from '@/i18n';
import { useI18n } from '@/i18n/client';

/** The processing state: a dot, or a spinner while it works (prototype knowledge.js `badge`, `.ks-status`). */
export function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const busy = status === 'pending' || status === 'processing';
  return (
    <span className={`ks-status ${status}`}>
      {busy ? <i className="spinner" /> : <i className="dot" />}
      {t.common.status[status as keyof typeof t.common.status] ?? status}
    </span>
  );
}

export function failureLabel(t: Messages, code: string | null): string {
  const failures = t.knowledge.failures;
  return code && code in failures ? failures[code as keyof typeof failures] : failures.unknown;
}
