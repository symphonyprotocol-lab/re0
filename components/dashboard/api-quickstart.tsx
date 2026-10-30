'use client';

import { useState } from 'react';
import { CopyButton } from '@/components/dashboard/copy-button';
import type { QuickstartTab } from '@/lib/dashboard/snippets';
import { useI18n } from '@/lib/i18n/client';

/**
 * REST quickstart with request/response samples -- design source frame
 * `lRoBh`. The tabs are built on the server from the deployment's base URL
 * and one of the workspace's own assets (`quickstartTabs` in
 * lib/dashboard/demo-data); this component only switches between them.
 */
export function ApiQuickstart({ tabs }: { tabs: [QuickstartTab, ...QuickstartTab[]] }) {
  const { t } = useI18n();
  const o = t.dashboard.overview;
  const [activeId, setActiveId] = useState(tabs[0].id);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  return (
    <>
      <div className="mt-[19px] flex gap-1" role="tablist" aria-label={o.quickstartTabsLabel}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === active.id}
            onClick={() => setActiveId(tab.id)}
            className={`h-8 rounded-full px-3.5 text-[11px] transition-colors ${
              tab.id === active.id ? 'bg-brand text-onbrand' : 'text-muted hover:text-ink'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="relative mt-3 w-full rounded-lg bg-subtle">
        <CopyButton
          value={active.request}
          label={o.quickstartRequestLabel}
          className="absolute top-2 right-2 text-muted hover:bg-mutedbg"
        />
        <pre className="overflow-x-auto p-4 pr-12 font-mono text-[12px] leading-[1.6] text-brandink">
          {active.request}
        </pre>
      </div>

      <p className="mt-4 text-[12px] text-steel">{o.quickstartResponse}</p>
      <pre className="mt-[7px] w-full overflow-x-auto rounded-lg bg-subtle p-4 font-mono text-[12px] leading-[1.6] text-warn">
        {active.response}
      </pre>
    </>
  );
}
