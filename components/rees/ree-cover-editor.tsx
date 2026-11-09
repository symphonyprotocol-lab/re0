'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { REE_COVER_MAX_BYTES, REE_IMAGE_EXTENSIONS } from '@/lib/constants';
import type { IntroProps } from '@/lib/domain/video';
import { useI18n } from '@/i18n/client';
import { PIcon } from '@/components/rees/proto-icon';
import { ReeCoverCrop } from '@/components/rees/ree-cover-crop';
import { ReeIdentityCover } from '@/components/rees/ree-identity-cover';

const ACCEPT = Object.keys(REE_IMAGE_EXTENSIONS).join(',');

export function ReeCoverEditor({ value, disabled, onChange, avatar, color, video, palette, children }: {
  value: File | string | null;
  disabled: boolean;
  onChange: (file: File | null) => void;
  avatar: string | null;
  color: string;
  video: IntroProps | null;
  palette: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const c = t.reeSetup.settings.cover;
  const input = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState('');
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [local, setLocal] = useState<{ file: File; url: string } | null>(null);

  useEffect(() => {
    if (!(value instanceof File)) return;
    const url = URL.createObjectURL(value);
    setLocal({ file: value, url });
    return () => URL.revokeObjectURL(url);
  }, [value]);

  const src = typeof value === 'string' ? `/media/${value}` : local && local.file === value ? local.url : null;

  function pick(file: File) {
    setError('');
    if (!Object.hasOwn(REE_IMAGE_EXTENSIONS, file.type) || !file.size || file.size > REE_COVER_MAX_BYTES) {
      setError(c.invalid);
      return;
    }
    setCropFile(file);
  }

  function finishCrop(file?: File) {
    if (file) onChange(file);
    setCropFile(null);
    requestAnimationFrame(() => uploadButton.current?.focus({ preventScroll: true }));
  }

  return (
    <div className="ree-identity-media">
      <ReeIdentityCover src={src} avatar={avatar} color={color} video={video} alt={c.label} placeholder={c.empty}>
        {palette}
      </ReeIdentityCover>
      <div className="ree-identity-controls">
        <div className="field" role="group" aria-labelledby="ree-cover-label">
          <span className="field-label" id="ree-cover-label">{c.label}</span>
          <div className="flex flex-wrap items-center gap-2">
            <button ref={uploadButton} type="button" className="btn secondary sm" disabled={disabled} onClick={() => input.current?.click()}>
              <PIcon name="upload" />
              {value ? c.replace : c.upload}
            </button>
            {value && (
              <button type="button" className="btn ghost sm" disabled={disabled} onClick={() => {
                setError('');
                onChange(null);
              }}>
                {c.remove}
              </button>
            )}
          </div>
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) pick(file);
            }}
          />
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        {children}
      </div>
      <small className="ree-identity-note">{t.reeSetup.settings.imageHint}</small>
      {cropFile && <ReeCoverCrop file={cropFile} onApply={finishCrop} onCancel={finishCrop} />}
    </div>
  );
}
