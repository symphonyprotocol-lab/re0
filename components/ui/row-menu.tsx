'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '@/components/ui/icons';
import './row-menu.css';

export interface MenuItem {
  label: string;
  icon?: IconName;
  /** For a link item, the click: it may take the navigation over (`preventDefault`). */
  onSelect: (event?: MouseEvent<HTMLAnchorElement>) => void;
  danger?: boolean;
  disabled?: boolean;
  /** A link instead of a button: followed as a link (crawlable), `onSelect` still runs on the click. */
  href?: string;
  hrefLang?: string;
  /** The item's text language, when it differs from the page's (a language's own name). */
  lang?: string;
  /** One of a set, the chosen one marked: a radio item with a check. */
  checked?: boolean;
  /** Marks a link the language boundary leaves to the browser (components/shell/locale-boundary.tsx). */
  localeSwitch?: boolean;
}

const ITEMS = 'button:not(:disabled), a[href]';

/**
 * A row's "⋯" menu (prototype conversations.js `menu`): opens beside its
 * button in a fixed layer, so a scrolling list never clips it; Escape or a
 * click elsewhere closes it and focus goes back to the button. Enter,
 * Space or ArrowDown on the button opens it on the chosen (or first) item;
 * the arrows, Home and End move between items. `trigger` and
 * `triggerClassName` replace the dots button's content and look; `width`
 * the panel's.
 */
export function RowMenu({
  label,
  items,
  className = '',
  trigger,
  triggerClassName,
  triggerLabel,
  width = 224,
  busy = false,
  prerender = false,
}: {
  label: string;
  items: MenuItem[];
  className?: string;
  trigger?: ReactNode;
  triggerClassName?: string;
  /** The button's accessible name, when it is not `label` (a menu whose button shows its current choice). */
  triggerLabel?: string;
  width?: number;
  /** While the last choice is being applied: the button says so and does not open. */
  busy?: boolean;
  /** Keep the closed menu's items in the page, hidden, so its links are in the HTML crawlers read. */
  prerender?: boolean;
}) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = useCallback(() => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const height = items.length * 36 + 12;
    setAt({
      left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width)),
      top: rect.bottom + height + 12 > window.innerHeight ? Math.max(12, rect.top - height - 4) : rect.bottom + 4,
    });
  }, [items.length, width]);
  useEffect(() => {
    if (!at) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        button.current?.focus();
      } else if (panel.current?.contains(event.target as Node) || button.current?.contains(event.target as Node)) return;
      setAt(null);
    };
    const away = () => setAt(null);
    window.addEventListener('keydown', close);
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', away);
    window.addEventListener('scroll', away, true);
    (panel.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? panel.current?.querySelector<HTMLElement>(ITEMS))?.focus();
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', away, true);
    };
  }, [at]);
  const entries = items.map((item) => {
    const content = (
      <>
        {item.icon && <Icon name={item.icon} />}
        <span className="row-menu-label" lang={item.lang}>{item.label}</span>
        {item.checked !== undefined && <Icon name="check" className={`row-menu-check${item.checked ? '' : ' is-hidden'}`} />}
      </>
    );
    const shared = {
      role: item.checked === undefined ? 'menuitem' : 'menuitemradio',
      'aria-checked': item.checked,
      className: `row-menu-item${item.danger ? ' is-danger' : ''}${item.checked ? ' is-checked' : ''}`,
    };
    /* A plain link: the browser follows it after `onSelect`, which must not wait on anything. */
    return item.href ? (
      <a key={item.label} {...shared} href={item.href} hrefLang={item.hrefLang} data-locale-switch={item.localeSwitch ? '' : undefined} onClick={(event) => item.onSelect(event)}>
        {content}
      </a>
    ) : (
      <button
        key={item.label}
        type="button"
        {...shared}
        disabled={item.disabled}
        onClick={() => {
          setAt(null);
          button.current?.focus();
          item.onSelect();
        }}
      >
        {content}
      </button>
    );
  });
  return (
    <>
      <button
        ref={button}
        type="button"
        className={triggerClassName ?? `icon-btn ${className}`}
        aria-label={triggerLabel ?? label}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        aria-busy={busy || undefined}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (busy) return;
          if (at) return setAt(null);
          open();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' || at || busy) return;
          event.preventDefault();
          open();
        }}
      >
        {trigger ?? <Icon name="dots" className="size-4" />}
      </button>
      {!at && prerender && (
        <div role="menu" aria-label={label} className="row-menu-panel" hidden>
          {entries}
        </div>
      )}
      {at && createPortal(
        <div
          ref={panel}
          role="menu"
          aria-label={label}
          className="row-menu-panel"
          style={{ top: at.top, left: at.left, width }}
          onKeyDown={(event) => {
            if (event.key === 'Tab') return setAt(null);
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const entries = Array.from(panel.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
            const current = entries.indexOf(document.activeElement as HTMLElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + entries.length) % entries.length;
            entries[next]?.focus();
          }}
        >
          {entries}
        </div>,
        document.body,
      )}
    </>
  );
}
