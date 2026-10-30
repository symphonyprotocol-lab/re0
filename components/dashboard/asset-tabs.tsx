'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/client';

export interface AssetTab {
  id: string;
  label: string;
  /** Null when the tab has nothing to show for this asset; it is then left out. */
  panel: ReactNode;
  /** Ids of sections inside the panel that links address directly (`#documents`, `#exchanges`). */
  anchors?: readonly string[];
  /**
   * A short word on the tab itself when something inside it waits on the
   * owner -- the submission materials to complete, or a submission ready
   * to confirm -- so the step is visible from any tab, not only from the
   * banner above. `alert` for something missing, `brand` for something ready.
   */
  badge?: { label: string; tone: 'alert' | 'brand' } | null;
}

/**
 * An asset's page, one group at a time: status and facts, its content and
 * builds, the widget, the page of its own, what visitors asked, and the
 * settings. Stacked, the dozen panels pushed everything past the facts below
 * the fold, and the two the owner comes back to most -- the widget and the
 * shared page -- sat in the middle of them.
 *
 * The tab is the URL hash, so a link to a section (`#widget` from the widget
 * overview, `#documents` from the documents pager) opens the tab that holds
 * it and a reload keeps it. Every panel stays mounted and the inactive ones
 * are hidden, so a form that is half filled in one survives a look at another.
 */
export function AssetTabs({ tabs }: { tabs: AssetTab[] }) {
  const { t } = useI18n();
  const shown = tabs.filter((tab) => tab.panel !== null && tab.panel !== undefined);
  const [active, setActive] = useState<string>(shown[0]?.id ?? '');
  /* The list is rebuilt on every server render; the listener reads the latest without re-binding. */
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    const fromHash = () => {
      const id = window.location.hash.slice(1);
      if (!id) return;
      const match = shownRef.current.find((tab) => tab.id === id || tab.anchors?.includes(id));
      if (!match) return;
      setActive(match.id);
      /* The section was hidden while the browser tried to scroll to it. */
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  const select = (id: string) => {
    setActive(id);
    /* Replace, not push: switching tabs is not a page the back button should revisit. */
    window.history.replaceState(null, '', `#${id}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label={t.dashboard.assetDetail.tabs.label}
        className="flex w-full gap-1 overflow-x-auto border-b border-line"
      >
        {shown.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${tab.id}-tab`}
            aria-selected={tab.id === active}
            aria-controls={`${tab.id}-panel`}
            onClick={() => select(tab.id)}
            className={`-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3.5 text-[13px] transition-colors ${
              tab.id === active
                ? 'border-brand font-medium text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {tab.label}
            {tab.badge ? (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none ${
                  tab.badge.tone === 'alert' ? 'bg-rose text-white' : 'bg-brand text-onbrand'
                }`}
              >
                {tab.badge.label}
              </span>
            ) : null}
          </button>
        ))}
      </div>
      {shown.map((tab) => (
        <div
          key={tab.id}
          id={`${tab.id}-panel`}
          role="tabpanel"
          aria-labelledby={`${tab.id}-tab`}
          hidden={tab.id !== active}
          className="flex flex-col gap-4"
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
