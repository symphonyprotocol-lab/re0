'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { ThumbnailPropsWithoutZod } from '@remotion/player';
import { VIDEO_FPS, VIDEO_FRAMES } from '@/lib/constants';
import { introSize, type IntroProps } from '@/lib/domain/video';

const loadStill = () => import('@/video/intro').then(({ ReeIntroStill }) => ({ default: ReeIntroStill }));
const Thumbnail = dynamic<ThumbnailPropsWithoutZod<IntroProps>>(
  () => import('@remotion/player').then((module) => module.Thumbnail),
  { ssr: false },
);

export function IntroCoverFrame({ video, lazy = false }: { video: IntroProps; lazy?: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = frame.current;
    if (!lazy || !node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '160px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [lazy]);
  const { width, height } = introSize(video.aspect);
  return (
    <div ref={frame} className="ree-intro-cover-frame relative aspect-video w-full overflow-hidden" aria-hidden="true">
      {visible && (
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2">
          <Thumbnail
            lazyComponent={loadStill}
            inputProps={video}
            compositionWidth={width}
            compositionHeight={height}
            durationInFrames={VIDEO_FRAMES}
            fps={VIDEO_FPS}
            frameToDisplay={0}
            style={{ width: '100%' }}
            errorFallback={() => null}
          />
        </div>
      )}
    </div>
  );
}
