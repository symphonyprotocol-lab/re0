'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef } from 'react';
import type { IntroProps } from '@/lib/domain/video';
import { VideoPoster, type CoverRee } from '@/components/video/video-cover';

const IntroPlayer = dynamic(() => import('@/components/video/intro-player').then((module) => module.IntroPlayer), {
  ssr: false,
  loading: () => <div className="aspect-video w-full animate-pulse rounded-[10px] bg-soft" />,
});

/**
 * The public page's introduction (prototype public-dot.js `inlinePublicVideo`):
 * the Player in place, with play / pause, progress, replay and fullscreen.
 * `?video=1` (the share link) scrolls to it and starts it, muted until the
 * visitor turns the sound on. The opening still shows while the Player loads.
 */
export function PublicIntro({ ree, video, autoPlay }: { ree: CoverRee; video: IntroProps; autoPlay: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoPlay) ref.current?.scrollIntoView({ block: 'center' });
  }, [autoPlay]);
  return (
    <div ref={ref} id="intro-player" className="relative">
      <IntroPlayer props={video} name={ree.name} autoPlay={autoPlay} />
      <noscript>
        <VideoPoster ree={ree} video={video} />
      </noscript>
    </div>
  );
}
