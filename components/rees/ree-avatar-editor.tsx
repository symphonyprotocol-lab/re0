'use client';

import { useEffect, useRef, useState } from 'react';
import { AVATAR_SIZE, AVATAR_SOURCE_MAX_BYTES } from '@/lib/constants';
import { uploadToBlob } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { avatarCrop } from '@/components/rees/avatar-editor';
import { DotAvatar, PIcon } from '@/components/rees/proto-icon';

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * A Ree's avatar in the wizard and its settings, as the prototype draws it
 * (dot-avatar.js `editor`): the preview, 上传 / 更换头像 and 使用默认, then a
 * crop panel with zoom and horizontal / vertical position sliders. "使用此头像"
 * crops to 512×512 in the browser and uploads the result to Blob; the form
 * saves the pathname with everything else, so cancelling the form keeps the
 * old avatar. `onCropping` reports an open crop, which the form must not save
 * past (prototype `beforeSubmit`).
 */
export function ReeAvatarEditor({
  value,
  color,
  onChange,
  onCropping,
  compact = false,
}: {
  value: string | null;
  color: string;
  onChange: (pathname: string | null) => void;
  onCropping?: (open: boolean) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const f = t.reeSetup.fields;
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  /* The prototype's units: zoom 1–3, position −100…100 of the room the zoom leaves. */
  const [crop, setCrop] = useState({ zoom: 1, x: 0, y: 0 });
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
    const centered = avatarCrop(image.naturalWidth, image.naturalHeight, crop.zoom);
    const rect = avatarCrop(
      image.naturalWidth,
      image.naturalHeight,
      crop.zoom,
      (crop.x * (centered.width - AVATAR_SIZE)) / 200,
      (crop.y * (centered.height - AVATAR_SIZE)) / 200,
    );
    const brush = canvas.getContext('2d')!;
    brush.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    brush.drawImage(image, rect.left, rect.top, rect.width, rect.height);
  }, [image, crop]);

  const pick = (file: File | undefined) => {
    setError('');
    if (!file) return;
    if (!TYPES.includes(file.type) || file.size > AVATAR_SOURCE_MAX_BYTES) {
      setError(f.avatarInvalid);
      return;
    }
    const loaded = new Image();
    loaded.onload = () => {
      setImage(loaded);
      setCrop({ zoom: 1, x: 0, y: 0 });
    };
    loaded.onerror = () => setError(f.avatarInvalid);
    loaded.src = URL.createObjectURL(file);
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

  const sliders = [
    ['zoom', f.cropZoom, 1, 3, 0.01],
    ['x', f.cropX, -100, 100, 1],
    ['y', f.cropY, -100, 100, 1],
  ] as const;

  return (
    <section className="dot-avatar-editor">
      <span className="field-label">{f.avatar}</span>
      <div className="dot-avatar-edit-row">
        {!compact && (
          <div className="dot-avatar-preview">
            <DotAvatar avatar={value} color={color} />
          </div>
        )}
        <div className="grow">
          <div className="dot-avatar-buttons">
            <button type="button" className="btn secondary sm" onClick={() => fileRef.current?.click()}>
              <PIcon name="upload" />
              {value ? f.avatarChange : f.avatarUpload}
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setImage(null);
                setError('');
                onChange(null);
              }}
            >
              {f.avatarDefault}
            </button>
          </div>
          {!compact && <p>{f.avatarHint}</p>}
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
      <p className="dot-avatar-error" role="alert" hidden={!error}>
        {error}
      </p>
      <div className="dot-avatar-crop" hidden={!image}>
        {image && (
          <>
            <h3>{f.cropTitle}</h3>
            <canvas ref={canvasRef} width={AVATAR_SIZE} height={AVATAR_SIZE} role="img" aria-label={f.reeCropPreview} />
            {sliders.map(([key, label, min, max, step]) => (
              <label key={key}>
                {label}
                <input
                  type="range"
                  aria-label={label}
                  min={min}
                  max={max}
                  step={step}
                  value={crop[key]}
                  autoFocus={key === 'zoom'}
                  onChange={(event) => setCrop((current) => ({ ...current, [key]: Number(event.target.value) }))}
                />
              </label>
            ))}
            <div className="dot-avatar-buttons">
              <button type="button" className="btn sm" onClick={() => void use()} disabled={busy}>
                {f.cropUse}
              </button>
              <button type="button" className="btn secondary sm" onClick={() => setImage(null)} disabled={busy}>
                {f.cropCancel}
              </button>
            </div>
          </>
        )}
      </div>
      {!compact && <small className="dot-avatar-save-note">{f.avatarNote}</small>}
    </section>
  );
}
