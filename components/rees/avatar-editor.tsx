'use client';

import { useEffect, useRef, useState } from 'react';
import { AVATAR_SIZE, AVATAR_SOURCE_MAX_BYTES } from '@/lib/constants';
import { uploadToBlob } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { Icon, Spinner } from '@/components/ui/icons';
import { ReeAvatar, UserAvatar } from '@/components/ui/ree-avatar';

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** The crop rectangle in source pixels for a square of the image, zoomed and offset (-100..100 each axis). */
function cropRect(width: number, height: number, zoom: number, x: number, y: number) {
  const side = Math.min(width, height) / zoom;
  const left = ((width - side) / 2) * (1 + x / 100);
  const top = ((height - side) / 2) * (1 + y / 100);
  return { left, top, side };
}

/**
 * Upload, zoom and position, then "使用此头像": the browser crops to 512×512
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
  const [zoom, setZoom] = useState(1);
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);
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
    const rect = cropRect(image.naturalWidth, image.naturalHeight, zoom, x, y);
    const brush = canvas.getContext('2d')!;
    brush.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    brush.drawImage(image, rect.left, rect.top, rect.side, rect.side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  }, [image, zoom, x, y]);

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
      setZoom(1);
      setX(0);
      setY(0);
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
              className={`size-36 flex-none border border-line bg-white ${kind === 'user' ? 'rounded-full' : 'rounded-2xl'}`}
            />
            <div className="flex flex-1 flex-col gap-3 text-[12px]">
              {(
                [
                  [f.cropZoom, zoom, setZoom, 1, 3, 0.01],
                  [f.cropX, x, setX, -100, 100, 1],
                  [f.cropY, y, setY, -100, 100, 1],
                ] as const
              ).map(([label, current, set, min, max, step]) => (
                <label key={label} className="flex flex-col gap-1">
                  {label}
                  <input type="range" min={min} max={max} step={step} value={current} onChange={(event) => set(Number(event.target.value))} />
                </label>
              ))}
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
