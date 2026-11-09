/**
 * A Ree's 15-second introduction (rebuild-proposal.md 2.6): one Remotion
 * composition shared by `@remotion/player` (playback on the public page,
 * cards and the editor) and `@remotion/web-renderer` (the owner's MP4
 * export), so both draw the same frames from the same props. Every video
 * type is narrated: see product-demo.tsx.
 */
import { VIDEO_FPS, VIDEO_FRAMES, type VideoAspect } from '@/lib/constants';
import { introSize, type IntroProps } from '@/lib/domain/video';
import { NarratedVideo } from './product-demo';

export function ReeIntro(props: IntroProps) {
  return <NarratedVideo {...props} />;
}

/** The same visual composition without loading audio for a still. */
export function ReeIntroStill(props: IntroProps) {
  return <NarratedVideo {...props} narrationUrl={undefined} music={false} />;
}

/** The composition as Player and `renderMediaOnWeb()` take it: 15 s, 24 fps, 720p in the chosen aspect. */
export function introComposition(aspect: VideoAspect) {
  return {
    id: 'ReeIntro',
    component: ReeIntro,
    durationInFrames: VIDEO_FRAMES,
    fps: VIDEO_FPS,
    ...introSize(aspect),
  };
}
