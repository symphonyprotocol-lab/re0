'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { IconName } from '@/components/ui/icons';
import { I } from '@/components/chat/message-parts';

export interface ConversationMenuItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
}

/**
 * A conversation's "⋯" (prototype conversations.js `menu`): a small dialog
 * headed by the conversation's title, beside the sidebar or under the row's
 * button, kept inside the window. Escape or a click elsewhere closes it and
 * focus goes back to the button.
 */
export function ConversationMenu({ title, label, items, beside = false }: { title: string; label: string; items: ConversationMenuItem[]; beside?: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const node = panel.current;
    const anchor = button.current;
    if (!open || !node || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    node.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, beside ? rect.right + 8 : rect.right - width))}px`;
    node.style.top = `${Math.max(12, Math.min(window.innerHeight - height - 12, rect.bottom + 5))}px`;
    node.querySelector<HTMLButtonElement>('.cl-menu .btn')?.focus();
  }, [open, beside]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        button.current?.focus();
      } else if (panel.current?.contains(event.target as Node) || button.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const away = () => setOpen(false);
    window.addEventListener('keydown', close);
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', away);
    window.addEventListener('scroll', away, true);
    return () => {
      window.removeEventListener('keydown', close);
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', away, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-btn"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <I name="dots" />
      </button>
      {open &&
        createPortal(
          <section ref={panel} className="cl-menu-dialog" role="dialog" aria-label={title}>
            <header className="modal-head">
              <div>
                <h2>{title}</h2>
              </div>
            </header>
            <div className="modal-body">
              <div className="cl-menu">
                {items.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    className="btn secondary sm"
                    onClick={() => {
                      setOpen(false);
                      item.onSelect();
                    }}
                  >
                    <I name={item.icon} />
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </section>,
          document.body,
        )}
    </>
  );
}
