'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AVATAR_SIZE, AVATAR_SOURCE_MAX_BYTES } from '@/lib/constants';
import { uploadToBlob } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { Spinner } from '@/components/ui/icons';
import { imageUrl } from '@/components/ui/ree-avatar';
import { avatarCrop } from '@/components/rees/avatar-editor';
import { I } from '@/components/settings/icon';

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** Larger images are refused before cropping (prototype profile.js: 24 megapixels). */
const MAX_PIXELS = 24_000_000;
/** Square pixels an arrow key moves the image; Shift moves further. */
const NUDGE = 8;
const NUDGE_FAR = 32;

/** "YZ" for "Yu Zhao", the first two characters of a single word (prototype `avatarInitials`). */
export function avatarInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0]![0]! + Array.from(parts.at(-1)!)[0] : Array.from(parts[0] || 'R').slice(0, 2).join('');
  return letters.toUpperCase();
}

/**
 * The profile photo (prototype profile.js `editor` / `showCrop`): the large
 * avatar with its camera badge, 上传头像 / 更换头像 and 恢复默认, and the crop
 * -- drag (or arrow keys) to place, zoom 100–300%, 重置位置. Per 8.2 the crop
 * opens in place rather than in a dialog, and 使用此头像 only uploads the
 * 512×512 result: the photo is saved with 保存资料, like every other field.
 * `onCropping` reports an open crop, which the form must not save past.
 */
export function ProfileAvatar({
  name,
  value,
  onChange,
  onCropping,
}: {
  name: string;
  value: string | null;
  onChange: (pathname: string | null) => void;
  onCropping: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const s = t.settings;
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ pointer: number; clientX: number; clientY: number; x: number; y: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const src = imageUrl(value);
  const cropping = image !== null;
  const croppingRef = useRef(onCropping);
  useEffect(() => {
    croppingRef.current = onCropping;
  });
  useEffect(() => croppingRef.current(cropping), [cropping]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    const rect = avatarCrop(image.naturalWidth, image.naturalHeight, crop.zoom, crop.x, crop.y);
    const brush = canvas.getContext('2d')!;
    brush.fillStyle = '#fff';
    brush.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    brush.drawImage(image, rect.left, rect.top, rect.width, rect.height);
  }, [image, crop]);

  const place = (zoom: number, x: number, y: number) => {
    if (!image) return;
    const rect = avatarCrop(image.naturalWidth, image.naturalHeight, zoom, x, y);
    setCrop({ zoom, x: rect.x, y: rect.y });
  };

  const open = (url: string, revoke: boolean) => {
    const loaded = new Image();
    loaded.crossOrigin = 'anonymous';
    loaded.onload = () => {
      if (revoke) URL.revokeObjectURL(url);
      if (loaded.naturalWidth * loaded.naturalHeight > MAX_PIXELS) return setError(s.avatarErrors.pixels);
      setError('');
      setCrop({ zoom: 1, x: 0, y: 0 });
      setImage(loaded);
    };
    loaded.onerror = () => {
      if (revoke) URL.revokeObjectURL(url);
      setError(revoke ? s.avatarErrors.unreadable : s.avatarErrors.reupload);
    };
    loaded.src = url;
  };

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!TYPES.includes(file.type)) return setError(s.avatarErrors.type);
    if (!file.size || file.size > AVATAR_SOURCE_MAX_BYTES) return setError(s.avatarErrors.size);
    open(URL.createObjectURL(file), true);
  };

  const edit = () => {
    if (src) open(src, false);
    else fileRef.current?.click();
  };

  const use = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setBusy(true);
    const webp = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
    const file = webp?.type === 'image/webp' ? webp : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    const uploaded = file ? await uploadToBlob(file, { purpose: 'avatar', contentType: file.type, size: file.size }) : null;
    setBusy(false);
    if (!uploaded || 'error' in uploaded) return setError(s.avatarErrors.upload);
    setError('');
    onChange(uploaded.pathname);
    setImage(null);
  };

  const nudge = (event: KeyboardEvent<HTMLCanvasElement>) => {
    const step = event.shiftKey ? NUDGE_FAR : NUDGE;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    place(crop.zoom, crop.x + move[0], crop.y + move[1]);
  };

  return (
    <div className="profile-avatar-field">
      <span className="field-label">{s.avatar}</span>
      <div className="profile-avatar-row">
        <button type="button" className="profile-avatar-edit" onClick={edit} aria-label={s.avatarEdit}>
          <span className="avatar profile-avatar-large">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {src ? <img src={src} alt={s.avatarAlt} referrerPolicy="no-referrer" /> : avatarInitials(name)}
          </span>
          <span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M4 6h4l2-3h4l2 3h4v15H4z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </span>
        </button>
        <div className="s-grow">
          <div className="profile-avatar-actions">
            <button type="button" className="btn secondary sm" onClick={() => fileRef.current?.click()}>
              <I name="upload" />
              {src ? s.avatarChange : s.avatarUpload}
            </button>
            {src && (
              <button type="button" className="btn ghost sm" onClick={() => onChange(null)}>
                {s.avatarDefault}
              </button>
            )}
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
          </div>
          <p>{s.avatarHint}</p>
          {error && (
            <p className="profile-avatar-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      {image && (
        <div className="profile-crop-panel" role="group" aria-labelledby="profile-crop-title">
          <div className="profile-crop-head">
            <h3 id="profile-crop-title">{s.crop.title}</h3>
            <p>{s.crop.body}</p>
          </div>
          <div className="profile-crop-editor">
            <canvas
              ref={canvasRef}
              width={AVATAR_SIZE}
              height={AVATAR_SIZE}
              role="img"
              tabIndex={0}
              aria-label={s.crop.preview}
              onKeyDown={nudge}
              onPointerDown={(event) => {
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
            />
            <div className="profile-crop-zoom">
              <label htmlFor="profile-avatar-zoom">{s.crop.zoom}</label>
              <input id="profile-avatar-zoom" type="range" min={1} max={3} step={0.01} value={crop.zoom} onChange={(event) => place(Number(event.target.value), crop.x, crop.y)} />
              <output htmlFor="profile-avatar-zoom">{Math.round(crop.zoom * 100)}%</output>
            </div>
            <button type="button" className="text-link" onClick={() => setCrop({ zoom: 1, x: 0, y: 0 })}>
              <I name="refresh" />
              {s.crop.reset}
            </button>
          </div>
          <div className="profile-crop-actions">
            <button type="button" className="btn ghost sm" onClick={() => setImage(null)}>
              {t.common.actions.cancel}
            </button>
            <button type="button" className="btn sm" onClick={use} disabled={busy}>
              {busy ? <Spinner /> : <I name="check" />}
              {s.crop.use}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
