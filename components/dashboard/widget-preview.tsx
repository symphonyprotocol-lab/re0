'use client';

import { useEffect, useRef, useState } from 'react';
import { PANEL } from '@/components/dashboard/ui';
import { MessagesSquareIcon, XIcon } from '@/components/ui/icons';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * The owner's try-out of a site key, from the dashboard (requirement.md
 * 9.4): the same widget page a visitor gets, in a dialog, with the
 * dashboard's own origin as the parent. The server admits that parent only
 * for a session that owns the key (lib/http/embed-preview.ts), so this is
 * not a way around the allowlist. Questions asked here are answered and
 * metered exactly as a visitor's would be, which is the point of trying.
 *
 * The page talks to its parent the way it talks to the loader on a real
 * site (public/widget.js): a cited page asks to be opened, which here is a
 * new tab, and the close button asks to be closed.
 */
export function WidgetPreview({ siteKey }: { siteKey: { id: string; key: string; name: string } }) {
  const { t, locale } = useI18n();
  const p = t.dashboard.widget.preview;
  const [open, setOpen] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = (event.data ?? {}) as { type?: string; url?: string };
      if (data.type === 're0:navigate' && typeof data.url === 'string') {
        let target: URL;
        try {
          target = new URL(data.url, window.location.href);
        } catch {
          return;
        }
        if (target.protocol === 'https:' || target.protocol === 'http:') {
          window.open(target.href, '_blank', 'noopener');
        }
      } else if (data.type === 're0:close') {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const src = open
    ? `/embed?key=${encodeURIComponent(siteKey.key)}&parent=${encodeURIComponent(window.location.origin)}&lang=${encodeURIComponent(locale)}`
    : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-card px-3 text-[11.5px] font-medium text-ink transition-colors hover:bg-subtle"
      >
        <MessagesSquareIcon size={13} />
        {p.open}
      </button>

      {open && src ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={fill(p.title, { name: siteKey.name })}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className={`${PANEL} flex w-full max-w-[420px] flex-col overflow-hidden`}>
            <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="truncate text-[13px] font-medium text-ink">{fill(p.title, { name: siteKey.name })}</p>
                <p className="text-[11px] leading-[1.5] text-muted">{p.hint}</p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={p.close}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-mutedbg hover:text-ink"
              >
                <XIcon size={15} />
              </button>
            </div>
            <iframe
              ref={frame}
              src={src}
              title={fill(p.title, { name: siteKey.name })}
              className="h-[600px] max-h-[calc(100vh-160px)] w-full border-0 bg-white"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
