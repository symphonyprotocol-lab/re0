'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/icons';

export interface MenuItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
  danger?: boolean;
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
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
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
          const width = 200;
          const height = items.length * 38 + 12;
          setAt({
            left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width)),
            top: rect.bottom + height + 12 > window.innerHeight ? Math.max(12, rect.top - height - 4) : rect.bottom + 4,
          });
        }}
      >
        {trigger ?? <Icon name="dots" className="size-4" />}
      </button>
      {at && (
        <div ref={panel} role="menu" aria-label={label} className="fixed z-[60] w-[200px] rounded-xl border border-line bg-white p-1.5 shadow-xl" style={{ top: at.top, left: at.left }}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12px] hover:bg-wash ${item.danger ? 'text-red' : 'text-ink'}`}
              onClick={() => {
                setAt(null);
                item.onSelect();
              }}
            >
              <Icon name={item.icon} className="size-3.5 flex-none" />
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
