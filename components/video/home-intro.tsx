'use client';

import { useState } from 'react';
import type { IntroProps } from '@/lib/domain/video';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';
import { IntroDialog } from '@/components/video/video-cover';

/**
 * The home page's 15-second entry (8.4 "首页 15 秒入口", prototype
 * `home-dot-card` 15s): the dark figure plays the introduction of the most
 * active public Ree that has one. The figure's text comes from the page.
 */
export function HomeIntro({ ree, video, title, body }: { ree: { name: string; slug: string }; video: IntroProps; title: string; body: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t.video.home.play}
        className="group relative flex aspect-video w-full min-w-0 flex-col justify-end overflow-hidden rounded-2xl bg-gradient-to-br from-[#0b1a4a] via-ink to-[#123a7a] p-6 text-left text-white"
      >
        <span className="absolute top-1/2 left-1/2 inline-flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/30 bg-white/10 backdrop-blur-sm transition group-hover:bg-blue" aria-hidden="true">
          <Icon name="play" className="size-7" />
        </span>
        <span className="absolute top-4 right-4 rounded-full bg-white/15 px-2.5 py-1 font-mono text-[11px]">0:15</span>
        <span>
          <strong className="block text-[18px]">{title}</strong>
          <span className="mt-1 line-clamp-2 block text-[12px] text-white/70">{body}</span>
          <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[11px]">
            <Icon name="film" className="size-3.5" />
            {ree.name}
          </span>
        </span>
      </button>
      {open && <IntroDialog open={open} onClose={() => setOpen(false)} video={video} name={ree.name} href={`/r/${ree.slug}`} linkLabel={t.video.dialog.details} />}
    </>
  );
}
