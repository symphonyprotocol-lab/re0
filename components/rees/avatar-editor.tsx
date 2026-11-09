'use client';

import { useEffect, useRef, useState } from 'react';
import { AVATAR_SIZE, AVATAR_SOURCE_MAX_BYTES } from '@/lib/constants';
import { imageCrop } from '@/lib/domain/image-crop';
import { uploadToBlob } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { Icon, Spinner } from '@/components/ui/icons';
import { ReeAvatar, UserAvatar } from '@/components/ui/ree-avatar';

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Where to draw the image in a `size`×`size` square: scaled to cover it, then
 * zoomed (1–3) and offset by `x`/`y` square pixels from centre. The offset is
 * clamped so the image always covers the square, and the clamped value comes
 * back as `x`/`y` (prototype profile.js `avatarCrop`).
 */
export function avatarCrop(width: number, height: number, zoom = 1, x = 0, y = 0, size = AVATAR_SIZE) {
  return imageCrop(width, height, size, size, zoom, x, y);
}

/** Square pixels an arrow key moves the image; Shift moves further. */
const NUDGE = 8;
const NUDGE_FAR = 32;

/**
 * Upload, zoom and drag (or arrow keys) to position, then "使用此头像": the browser crops to 512×512
 * and uploads the result to Blob; the form saves the pathname with everything
 * else, so cancelling the form keeps the old avatar (prototype dot-avatar.js).
 * `onCropping` reports an open crop, which the form must not save past
 * (prototype `beforeSubmit`: "请先选择“使用此头像”或取消裁剪，再保存。").
 */
export function AvatarEditor({
  value,
  color,
  onChange,
  kind = 'ree',
  name = '',
  labels,
  onCropping,
}: {
  value: string | null;
  color?: string;
  onChange: (pathname: string | null) => void;
  kind?: 'ree' | 'user';
  name?: string;
  labels: { title: string; upload: string; change: string; reset: string; hint: string; note?: string };
  onCropping?: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const f = t.reeSetup.fields;
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ pointer: number; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const cropping = image !== null;
  const croppingRef = useRef(onCropping);
  useEffect(() => {
    croppingRef.current = onCropping;
  });
  useEffect(() => croppingRef.current?.(cropping), [cropping]);
  useEffect(() => () => croppingRef.current?.(false), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const rect = avatarCrop(image.naturalWidth, image.naturalHeight, crop.zoom, crop.x, crop.y);
    const brush = canvas.getContext('2d')!;
    brush.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    brush.drawImage(image, rect.left, rect.top, rect.width, rect.height);
  }, [image, crop]);

  /** Moves or zooms, keeping the stored offset clamped so it never drifts past an edge. */
  const place = (zoom: number, x: number, y: number) => {
    if (!image) return;
    const rect = avatarCrop(image.naturalWidth, image.naturalHeight, zoom, x, y);
    setCrop({ zoom, x: rect.x, y: rect.y });
  };

  const pick = (file: File | undefined) => {
    setError('');
    if (!file) return;
    if (!TYPES.includes(file.type) || file.size > AVATAR_SOURCE_MAX_BYTES) {
      setError(f.avatarInvalid);
      return;
    }
    const url = URL.createObjectURL(file);
    const loaded = new Image();
    loaded.onload = () => {
      setImage(loaded);
      setCrop({ zoom: 1, x: 0, y: 0 });
    };
    loaded.onerror = () => setError(f.avatarInvalid);
    loaded.src = url;
  };

  const use = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setBusy(true);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    const type = blob?.type === 'image/webp' ? 'image/webp' : 'image/png';
    const file = blob?.type === 'image/webp' ? blob : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!file) {
      setBusy(false);
      setError(f.avatarUploadFailed);
      return;
    }
    const result = await uploadToBlob(file, { purpose: 'avatar', contentType: type, size: file.size });
    setBusy(false);
    if ('error' in result) {
      setError(f.avatarUploadFailed);
      return;
    }
    onChange(result.pathname);
    setImage(null);
  };

  return (
    <section>
      <span className="field-label">{labels.title}</span>
      <div className="flex items-center gap-4">
        {kind === 'ree' ? <ReeAvatar avatar={value} color={color} size="lg" /> : <UserAvatar avatar={value} name={name} className="size-16 text-[16px]" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
              <Icon name="upload" className="size-3.5" />
              {value ? labels.change : labels.upload}
            </button>
            <button type="button" className="btn-ghost" onClick={() => onChange(null)} disabled={!value}>
              {labels.reset}
            </button>
          </div>
          <p className="hint">{labels.hint}</p>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(event) => {
          pick(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-red">
          {error}
        </p>
      )}
      {image && (
        <div className="mt-4 rounded-xl border border-line bg-wash p-4">
          <strong className="text-[12px]">{f.cropTitle}</strong>
          <div className="mt-3 flex flex-col gap-4 sm:flex-row">
            <canvas
              ref={canvasRef}
              width={AVATAR_SIZE}
              height={AVATAR_SIZE}
              tabIndex={0}
              role="img"
              aria-label={f.cropPreview}
              className={`size-36 flex-none cursor-grab touch-none border border-line bg-white active:cursor-grabbing ${kind === 'user' ? 'rounded-full' : 'rounded-2xl'}`}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = { pointer: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: crop.x, y: crop.y };
              }}
              onPointerMove={(event) => {
                const start = drag.current;
                if (!start || start.pointer !== event.pointerId) return;
                const ratio = AVATAR_SIZE / event.currentTarget.getBoundingClientRect().width;
                place(crop.zoom, start.x + (event.clientX - start.clientX) * ratio, start.y + (event.clientY - start.clientY) * ratio);
              }}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
              onKeyDown={(event) => {
                const step = event.shiftKey ? NUDGE_FAR : NUDGE;
                const move = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[event.key];
                if (!move) return;
                event.preventDefault();
                place(crop.zoom, crop.x + move[0], crop.y + move[1]);
              }}
            />
            <div className="flex flex-1 flex-col gap-3 text-[12px]">
              <p className="text-muted">{f.cropHint}</p>
              <label className="flex flex-col gap-1">
                {f.cropZoom}
                <span className="flex items-center gap-3">
                  <input
                    type="range"
                    className="min-w-0 flex-1"
                    min={1}
                    max={3}
                    step={0.01}
                    value={crop.zoom}
                    onChange={(event) => place(Number(event.target.value), crop.x, crop.y)}
                  />
                  <output className="w-10 text-right font-mono text-[11px] text-muted">{Math.round(crop.zoom * 100)}%</output>
                </span>
              </label>
              <button type="button" className="btn-ghost self-start" onClick={() => setCrop({ zoom: 1, x: 0, y: 0 })}>
                <Icon name="refresh" className="size-3.5" />
                {f.cropReset}
              </button>
              <div className="flex gap-2">
                <button type="button" className="btn btn-sm" onClick={use} disabled={busy}>
                  {busy ? <Spinner className="size-3.5" /> : <Icon name="check" className="size-3.5" />}
                  {f.cropUse}
                </button>
                <button type="button" className="btn-ghost" onClick={() => setImage(null)}>
                  {t.common.actions.cancel}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {labels.note && <p className="hint">{labels.note}</p>}
    </section>
  );
}
