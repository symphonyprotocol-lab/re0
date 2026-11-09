'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { REE_COVER_MAX_BYTES, REE_IMAGE_EXTENSIONS } from '@/lib/constants';
import { imageCrop } from '@/lib/domain/image-crop';
import { useI18n } from '@/i18n/client';
import { Modal } from '@/components/ui/modal';

const WIDTH = 1280;
const HEIGHT = 720;
const CENTER = { zoom: 1, x: 0, y: 0 };
const DIRECTIONS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export function ReeCoverCrop({ file, onApply, onCancel }: {
  file: File;
  onApply: (file: File) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const c = t.reeSetup.settings.cover;
  const f = t.reeSetup.fields;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: number; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const cancelled = useRef(false);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState(CENTER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'read' | 'export' | null>(null);
  const zoomLabel = `${Math.round(crop.zoom * 100)}%`;

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const loaded = new Image();
    loaded.onload = () => {
      if (loaded.naturalWidth && loaded.naturalHeight) setImage(loaded);
      else setError('read');
    };
    loaded.onerror = () => setError('read');
    loaded.src = url;
    return () => {
      loaded.onload = loaded.onerror = null;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  useLayoutEffect(() => {
    const brush = canvasRef.current?.getContext('2d');
    if (!brush || !image) return;
    const { left, top, width, height } = imageCrop(image.naturalWidth, image.naturalHeight, WIDTH, HEIGHT, crop.zoom, crop.x, crop.y);
    brush.clearRect(0, 0, WIDTH, HEIGHT);
    brush.drawImage(image, left, top, width, height);
  }, [image, crop]);

  function place(zoom: number, x: number, y: number) {
    if (!image || busy) return;
    const rect = imageCrop(image.naturalWidth, image.naturalHeight, WIDTH, HEIGHT, zoom, x, y);
    setCrop({ zoom, x: rect.x, y: rect.y });
  }

  function cancel() {
    cancelled.current = true;
    onCancel();
  }

  async function apply() {
    const canvas = canvasRef.current;
    if (!canvas || !image || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Browsers without a WebP encoder return PNG. At 1280×720 it fits the upload limit.
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.92));
      if (cancelled.current) return;
      if (!blob?.size || blob.size > REE_COVER_MAX_BYTES || !Object.hasOwn(REE_IMAGE_EXTENSIONS, blob.type)) {
        setError('export');
        return;
      }
      const extension = REE_IMAGE_EXTENSIONS[blob.type as keyof typeof REE_IMAGE_EXTENSIONS];
      onApply(new File([blob], `cover.${extension}`, { type: blob.type }));
    } catch {
      if (!cancelled.current) setError('export');
    } finally {
      if (!cancelled.current) setBusy(false);
    }
  }

  return createPortal(
    <Modal
      open
      wide
      title={c.cropTitle}
      subtitle={c.cropHint}
      onClose={cancel}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={cancel}>{t.common.actions.cancel}</button>
          <button type="button" className="btn" disabled={!image || busy} onClick={() => void apply()}>
            {c.cropUse}
          </button>
        </>
      }
    >
      <canvas
        ref={canvasRef}
        width={WIDTH}
        height={HEIGHT}
        tabIndex={image ? 0 : undefined}
        role="img"
        aria-label={c.cropPreview}
        className={`block aspect-video h-auto w-full touch-none rounded-lg bg-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue${image ? ' cursor-grab active:cursor-grabbing' : ''}`}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current || !image || busy) return;
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: crop.x, y: crop.y };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          const scale = WIDTH / event.currentTarget.getBoundingClientRect().width;
          place(crop.zoom, start.x + (event.clientX - start.clientX) * scale, start.y + (event.clientY - start.clientY) * scale);
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.id === event.pointerId) drag.current = null;
        }}
        onKeyDown={(event) => {
          const direction = DIRECTIONS[event.key];
          if (!direction) return;
          event.preventDefault();
          const step = event.shiftKey ? 32 : 8;
          place(crop.zoom, crop.x + direction[0] * step, crop.y + direction[1] * step);
        }}
      />
      {image ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="flex min-w-44 flex-1 items-center gap-3 text-[13px]">
            {f.cropZoom}
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={crop.zoom}
              aria-valuetext={zoomLabel}
              disabled={busy}
              onChange={(event) => place(Number(event.target.value), crop.x, crop.y)}
              className="min-w-0 flex-1 accent-blue"
            />
            <span className="w-10 text-right font-mono text-[11px] text-muted" aria-hidden="true">{zoomLabel}</span>
          </label>
          <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => setCrop(CENTER)}>
            {f.cropReset}
          </button>
        </div>
      ) : !error && <p className="mt-3 text-[13px] text-muted" role="status">{c.cropLoading}</p>}
      {error && (
        <p className="mt-3 text-[13px] text-red" role="alert">{error === 'read' ? c.cropUnreadable : c.cropFailed}</p>
      )}
    </Modal>,
    document.body,
  );
}
