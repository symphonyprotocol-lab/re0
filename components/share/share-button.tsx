'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';

export type ShareState = 'public' | 'private' | 'moderated';

/**
 * 「分享」 and its dialog: the share page's link to copy, a QR code to scan
 * or download, and the system share sheet where the browser has one. A
 * private or taken-down Ree has no share page; the dialog says why and, for
 * a private one, points to its settings.
 */
export function ShareButton({
  ree,
  state,
  settingsHref,
  className = 'btn-ghost',
  labelClassName = 'hidden lg:inline',
}: {
  ree: { name: string; slug: string; description?: string };
  state: ShareState;
  settingsHref?: string;
  className?: string;
  labelClassName?: string;
}) {
  const { t } = useI18n();
  const s = t.share;
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || state !== 'public') return;
    const link = `${window.location.origin}/s/${ree.slug}`;
    setUrl(link);
    setCanShare(typeof navigator.share === 'function');
    let live = true;
    void import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(link, { margin: 1, width: 480, errorCorrectionLevel: 'M', color: { dark: '#091135', light: '#ffffff' } }))
      .then((data) => live && setQr(data))
      .catch(() => live && setQr(null));
    return () => {
      live = false;
    };
  }, [open, state, ree.slug]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast(s.dialog.copied);
    } catch {
      input.current?.select();
      toast(s.dialog.copyFailed);
    }
  };

  const systemShare = async () => {
    try {
      await navigator.share({ title: ree.name, text: fill(s.dialog.text, { name: ree.name }), url });
    } catch {
      /* dismissed */
    }
  };

  return (
    <>
      <button type="button" className={className} title={s.button} aria-label={s.button} onClick={() => setOpen(true)}>
        <Icon name="share" />
        <span className={labelClassName}>{s.button}</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={state === 'public' ? s.dialog.title : s.dialog.privateTitle} subtitle={state === 'public' ? s.dialog.subtitle : ree.name}>
        {state === 'public' ? (
          <div className="flex flex-col gap-5">
            <div>
              <label htmlFor="share-link" className="field-label">
                {s.dialog.link}
              </label>
              <div className="flex gap-2">
                <input id="share-link" ref={input} className="input min-w-0 flex-1 font-mono text-[12px]" value={url} readOnly onFocus={(event) => event.currentTarget.select()} />
                <button type="button" className="btn flex-none" onClick={() => void copy()} disabled={!url}>
                  <Icon name="copy" />
                  {s.dialog.copy}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-4 rounded-[12px] border border-line bg-wash p-4">
              <div className="flex size-[132px] flex-none items-center justify-center overflow-hidden rounded-[10px] border border-line bg-white">
                {qr ? <img src={qr} alt={fill(s.dialog.qrAlt, { name: ree.name })} className="size-[124px]" /> : <Icon name="qr" className="size-8 text-[#c4cce0]" />}
              </div>
              <div className="min-w-0">
                <h3 className="text-[13px] font-semibold">{s.dialog.qr}</h3>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">{s.dialog.qrHint}</p>
                {qr && (
                  <a href={qr} download={`${ree.slug}-share-qr.png`} className="btn-secondary btn-sm mt-3">
                    <Icon name="download" />
                    {s.dialog.downloadQr}
                  </a>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {canShare && (
                <button type="button" className="btn-secondary" onClick={() => void systemShare()}>
                  <Icon name="share" />
                  {s.dialog.system}
                </button>
              )}
              <Link href={`/s/${ree.slug}`} className="btn-secondary" onClick={() => setOpen(false)}>
                <Icon name="external" />
                {s.dialog.open}
              </Link>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-4">
            <p className="text-[13px] leading-relaxed text-muted">{state === 'moderated' ? s.dialog.moderatedBody : s.dialog.privateBody}</p>
            {state === 'private' && settingsHref && (
              <Link href={settingsHref} className="btn" onClick={() => setOpen(false)}>
                <Icon name="settings" />
                {s.dialog.goSettings}
              </Link>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
