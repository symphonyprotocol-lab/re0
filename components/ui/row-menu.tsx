'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '@/components/ui/icons';
import './row-menu.css';

export interface MenuItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * A row's "⋯" menu (prototype conversations.js `menu`): opens beside its
 * button in a fixed layer, so a scrolling list never clips it; Escape or a
 * click elsewhere closes it and focus goes back to the button.
 */
export function RowMenu({ label, items, className = '', trigger }: { label: string; items: MenuItem[]; className?: string; trigger?: ReactNode }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
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
    panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', away, true);
    };
  }, [at]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`icon-btn ${className}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (at) return setAt(null);
          const rect = event.currentTarget.getBoundingClientRect();
          const width = 224;
          const height = items.length * 36 + 12;
          setAt({
            left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width)),
            top: rect.bottom + height + 12 > window.innerHeight ? Math.max(12, rect.top - height - 4) : rect.bottom + 4,
          });
        }}
      >
        {trigger ?? <Icon name="dots" className="size-4" />}
      </button>
      {at && createPortal(
        <div
          ref={panel}
          role="menu"
          aria-label={label}
          className="row-menu-panel"
          style={{ top: at.top, left: at.left }}
          onKeyDown={(event) => {
            if (event.key === 'Tab') return setAt(null);
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`row-menu-item${item.danger ? ' is-danger' : ''}`}
              onClick={() => {
                setAt(null);
                button.current?.focus();
                item.onSelect();
              }}
            >
              <Icon name={item.icon} />
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
