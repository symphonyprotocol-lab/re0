'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import type { IntroProps } from '@/lib/domain/video';
import { PALETTES, mix } from '@/video/theme';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { Modal } from '@/components/ui/modal';
import { ReeAvatar } from '@/components/ui/ree-avatar';

/* The Player and the composition load only when someone presses play. */
const IntroPlayer = dynamic(() => import('@/components/video/intro-player').then((module) => module.IntroPlayer), {
  ssr: false,
  loading: () => <div className="aspect-video w-full animate-pulse rounded-[10px] bg-soft" />,
});

export interface CoverRee {
  name: string;
  avatarBlob: string | null;
  color: string;
}

/**
 * The 16:9 cover of a Ree without an introduction (prototype
 * discovery-video.js `renderVideoPlaceholder`): brand line, avatar, name,
 * 暂无视频介绍. Explore, My Rees, `/videos`, the public page and the editor
 * share it.
 */
export function VideoPlaceholder({ ree, className = '' }: { ree: CoverRee; className?: string }) {
  const { t } = useI18n();
  return (
    <span
      role="img"
      aria-label={`${ree.name}: ${t.video.placeholder.none}`}
      className={`relative flex aspect-video w-full flex-col items-center justify-center gap-2 overflow-hidden bg-gradient-to-br from-[#f3f7ff] to-[#f5f3ff] px-4 text-center ${className}`}
    >
      <span className="absolute top-3 left-4 flex items-center gap-2 font-mono text-[11px] font-bold text-blue" aria-hidden="true">
        RE0 <span className="text-[7px] font-normal tracking-[0.12em] text-[#9fb1ca]">YOUR KNOWLEDGE. A NEW VOICE.</span>
      </span>
      <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="lg" />
      <strong className="max-w-[85%] truncate text-[13px] text-ink">{ree.name}</strong>
      <small className="flex items-center gap-1 text-[10px] text-muted">
        <Icon name="film" className="size-3" />
        {t.video.placeholder.none}
      </small>
      <span className="absolute bottom-3 hidden text-[10px] text-[#9fb1ca] sm:block" aria-hidden="true">
        {t.video.placeholder.caption}
      </span>
    </span>
  );
}

/**
 * A Ree with an introduction: its opening shot as a still, in the saved
 * template and accent (prototype `discoveryCoverContent`), with 含视频介绍
 * and the length. Drawn in plain CSS, so cards cost no Player.
 */
export function VideoPoster({ ree, video, className = '' }: { ree: CoverRee; video: IntroProps; className?: string }) {
  const { t } = useI18n();
  const palette = PALETTES[video.template] ?? PALETTES.editorial;
  return (
    <span className={`relative flex aspect-video w-full flex-col items-center justify-center gap-2 overflow-hidden px-4 text-center ${className}`} style={{ backgroundColor: palette.background }}>
      <span
        aria-hidden="true"
        className="absolute -top-1/3 -right-[8%] aspect-square h-[80%] rounded-full border"
        style={{ borderColor: mix(video.accent, palette.background, 0.16) }}
      />
      <span className="absolute top-3 left-4 font-mono text-[11px] font-bold" style={{ color: palette.watermark(video.accent) }} aria-hidden="true">
        RE0
      </span>
      <span className="font-mono text-[8px] tracking-[0.16em]" style={{ color: palette.faint }} aria-hidden="true">
        MEET YOUR KNOWLEDGE COMPANION
      </span>
      <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="md" />
      <strong className="max-w-[88%] truncate text-[15px]" style={{ color: palette.title, fontFamily: palette.titleFont }}>
        {video.scenes.opening.name}
      </strong>
      <span className="max-w-[88%] truncate text-[11px]" style={{ color: palette.body }}>
        {video.scenes.opening.position}
      </span>
      <span className="absolute bottom-2.5 left-3 inline-flex items-center gap-1 rounded-full bg-ink/70 px-2 py-0.5 text-[10px] font-medium text-white">
        <Icon name="film" className="size-3" />
        {t.video.card.has}
      </span>
      <span className="absolute right-3 bottom-2.5 rounded-full bg-ink/70 px-2 py-0.5 font-mono text-[10px] text-white">00:15</span>
    </span>
  );
}

/** The 15-second dialog (prototype `playVideoModal`): the Player, playing with sound, and the way on. */
export function IntroDialog({ open, onClose, video, name, href, linkLabel }: { open: boolean; onClose: () => void; video: IntroProps; name: string; href: string; linkLabel: string }) {
  const { t } = useI18n();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.video.dialog.title}
      subtitle={name}
      wide
      footer={
        <Link href={href} className="btn">
          {linkLabel}
          <Icon name="arrow" />
        </Link>
      }
    >
      <IntroPlayer props={video} name={name} autoPlay={false} fullscreen />
      <p className="hint mt-3">{t.video.dialog.note}</p>
    </Modal>
  );
}

/** A round play button over a cover; it opens the dialog. Lives beside the cover's link, never inside it. */
export function PlayIntroButton({ video, name, href, linkLabel, className = '' }: { video: IntroProps; name: string; href: string; linkLabel: string; className?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={fill(t.video.card.playLabel, { name })}
        className={`inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3 py-1.5 text-[11px] font-semibold text-ink shadow-md ring-1 ring-black/5 transition hover:bg-blue hover:text-white ${className}`}
      >
        <Icon name="play" className="size-3.5" />
        {t.video.card.watch}
      </button>
      {open && <IntroDialog open={open} onClose={() => setOpen(false)} video={video} name={name} href={href} linkLabel={linkLabel} />}
    </>
  );
}
