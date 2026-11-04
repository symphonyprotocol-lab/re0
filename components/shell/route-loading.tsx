'use client';

import { useI18n } from '@/i18n/client';
import { useRouteLoading } from '@/components/shell/navigation-provider';

/** Shared route fallback, rendered inside each persistent page shell. */
export function RouteLoading() {
  useRouteLoading();
  const { t } = useI18n();
  return (
    <section className="route-loading" aria-busy="true" aria-label={t.common.actions.loading}>
      <p className="route-loading-status" role="status"><i className="spinner" aria-hidden="true" />{t.common.actions.loading}</p>
      <div className="route-loading-heading" aria-hidden="true"><i /><i /></div>
      <div className="route-loading-grid" aria-hidden="true">
        <div className="route-loading-card"><i /><i /><i /></div>
        <div className="route-loading-card"><i /><i /><i /></div>
      </div>
    </section>
  );
}
