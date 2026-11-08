/**
 * The narrated 15-second video every type shares: its picture (the product
 * demo's, or one of the scenes in story-scenes.tsx), the voiceover with
 * captions, the music ducked under speech and the progress line. Built
 * along the remotion-markup skill: animation from `useCurrentFrame()` and
 * `interpolate()` only, no CSS transitions.
 */
import { Audio } from '@remotion/media';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { CSSProperties } from 'react';
import type { ProductDemo, VideoStory } from '@/lib/domain/product-demo';
import { type IntroProps } from '@/lib/domain/video';
import { MONO, SANS, mix } from './theme';
import { Glyph } from './parts';
import { DemoScene, demoTone } from './product-demo-scenes';
import { ArticleScene, CourseScene, ManualScene, type Beats } from './story-scenes';

const INK = '#14243b';
const MUTED = '#52657d';
const MUSIC = '/video/product-demo-music.mp3';
const ease = (frame: number, start: number, end: number) =>
  interpolate(frame, [start, end], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });

const card: CSSProperties = { border: '1px solid #dae4f1', borderRadius: 14, background: '#f6f9fd', padding: '20px 23px' };

/** The picture of a product demo: one of its four layouts, drawn under the shared captions. */
function ProductDemoPicture({ demo, name, accent }: { demo: ProductDemo; name: string; accent: string }) {
  const frame = useCurrentFrame();
  const preparation = demo.cues[1]!.start;
  const action = demo.cues[2]!.start;
  const result = demo.cues[3]!.start;
  const visual = demo.visual;
  const publish = visual ? ease(frame, result, result + 12) : ease(frame, action + 5, action + 18);
  const click = visual ? ease(frame, action, action + 9) : ease(frame, action - 4, action + 5);
  const typed = ease(frame, preparation, Math.max(preparation + 1, visual ? demo.cues[1]!.end : action - 5));
  const shared = ease(frame, result, result + 12);
  const example = Array.from(demo.exampleText);
  const visibleText = example.slice(0, Math.ceil(typed * example.length)).join('');

  return (
    <AbsoluteFill style={{ background: visual ? `linear-gradient(116deg,#f7f9fc,${mix(demoTone(visual), '#ffffff', .14)})` : 'linear-gradient(116deg,#f7f9fc,#edf4ff)' }}>
      {visual && visual.layout !== 'web-app' ? (
        <DemoScene demo={demo} visual={visual} accent={accent} input={typed} action={ease(frame, action, demo.cues[2]!.end)} result={shared} />
      ) : <>
      <div style={{ position: 'absolute', inset: '144px 46px 153px 545px', backgroundImage: 'radial-gradient(#b8cce6 1px,transparent 1px)', backgroundSize: '18px 18px', opacity: .52 }} />
      <header style={{ position: 'absolute', top: 51, left: 68, right: 68, paddingBottom: 17, borderBottom: '1px solid #d9e4f1', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 27, fontWeight: 750 }}>
          <span style={{ background: accent, color: 'white', padding: 8, borderRadius: 9, display: 'flex' }}><Glyph name="file" color="white" size={24} /></span>
          {name}
        </div>
        <span style={{ fontSize: 13, color: MUTED, fontFamily: MONO }}>AI VOICEOVER / 15 S</span>
      </header>

      <div style={{ position: 'absolute', left: 68, top: 162, width: 462 }}>
        <div style={{ fontSize: 15, color: accent, fontFamily: MONO, letterSpacing: 1.8, marginBottom: 28 }}>PRODUCT DEMO</div>
        <h1 style={{ margin: 0, fontSize: demo.headline.length > 32 ? 49 : 60, lineHeight: 1.08, letterSpacing: -2.8, overflowWrap: 'anywhere' }}>{demo.headline}</h1>
        <p style={{ margin: '23px 0 0', fontSize: 24, lineHeight: 1.45, color: MUTED, overflowWrap: 'anywhere' }}>{demo.summary}</p>
      </div>
      <div style={{ position: 'absolute', top: 519, left: 68, width: 462, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
        {demo.steps.map((label, index) => {
          const from = [preparation, action, result][index]!;
          const lit = ease(frame, from, from + 8);
          return (
            <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, color: mix(INK, MUTED, 1 - lit), fontSize: 16, fontWeight: 650 }}>
              <span style={{ flex: 'none', background: mix(accent, '#e4ecf8', 1 - lit), color: mix('#ffffff', MUTED, 1 - lit), padding: '7px 8px', borderRadius: 8, fontFamily: MONO, fontSize: 12 }}>0{index + 1}</span>
              <span style={{ lineHeight: 1.2, overflowWrap: 'anywhere' }}>{label}</span>
            </div>
          );
        })}
      </div>

      <div style={{ position: 'absolute', top: 146, left: 560, width: 640, height: 416, borderRadius: 22, background: 'white', border: '1px solid #d1deee', boxShadow: '0 18px 44px #2a527425', padding: 15 }}>
        <div style={{ display: 'flex', height: 45, alignItems: 'center', padding: '0 15px', background: '#f0f5fb', borderRadius: 11, color: MUTED, fontSize: 14 }}>
          <span style={{ color: '#8fa8cb', letterSpacing: 3 }}>●●●</span>
          <span style={{ flex: 1, textAlign: 'center' }}>{visual?.subject ?? name}</span>
          <span style={{ width: 40, color: accent, fontFamily: MONO }}>DEMO</span>
        </div>
        <div style={{ position: 'absolute', inset: '78px 25px 22px', opacity: 1 - publish, transform: `translateY(${-9 * publish}px)` }}>
          <div style={{ ...card, height: 233 }}>
            <div style={{ color: accent, fontFamily: MONO, fontSize: 13, letterSpacing: 1.5, marginBottom: 18 }}>EXAMPLE INPUT</div>
            <strong style={{ fontSize: 27, display: 'block' }}>{demo.exampleTitle}</strong>
            <p style={{ color: MUTED, fontSize: 21, lineHeight: 1.45, marginTop: 16, overflowWrap: 'anywhere' }}>{visibleText}{typed > 0 && typed < 1 ? '▍' : ''}</p>
          </div>
          <div style={{ position: 'absolute', right: 0, bottom: 0, background: accent, color: 'white', borderRadius: 10, padding: '12px 18px', fontSize: 17, fontWeight: 700, transform: `scale(${1 - .055 * click})` }}>
            {demo.steps[1]}
          </div>
          <span style={{ position: 'absolute', right: 16, bottom: -9, fontSize: 30, color: INK, opacity: click * (1 - publish) }}>➚</span>
        </div>
        <div style={{ position: 'absolute', inset: '78px 25px 22px', opacity: publish, transform: `translateY(${12 * (1 - publish)}px)` }}>
          <div style={{ ...card, minHeight: 175 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <strong style={{ fontSize: 30 }}>{demo.exampleTitle}</strong>
              <span style={{ color: '#18745c', background: '#def4ea', borderRadius: 24, padding: '4px 9px', flexShrink: 0 }}>✓</span>
            </div>
            <p style={{ color: MUTED, fontSize: 22, lineHeight: 1.38, margin: '13px 0 0', overflowWrap: 'anywhere' }}>{demo.result}</p>
          </div>
          <div style={{ ...card, background: '#eaf2ff', marginTop: 18, display: 'flex', alignItems: 'center', gap: 14, opacity: .5 + .5 * shared }}>
            <div style={{ background: mix(accent, '#eaf2ff', .85), color: accent, borderRadius: 10, padding: 8, display: 'flex' }}><Glyph name="check" color={accent} size={23} /></div>
            <strong style={{ fontSize: 20 }}>{demo.steps[2]}</strong>
          </div>
        </div>
      </div>
      </>}
    </AbsoluteFill>
  );
}

/** Each beat's entrance (eased over half a second) and how far its line has been spoken, from the cues. */
function beatsAt(story: VideoStory, frame: number): Beats {
  const enter = [1, 2, 3].map((index) => ease(frame, story.cues[index]!.start, story.cues[index]!.start + 12)) as Beats['enter'];
  const through = [1, 2, 3].map((index) => {
    const cue = story.cues[index]!;
    return interpolate(frame, [cue.start, Math.max(cue.start + 1, cue.end)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  }) as Beats['through'];
  const active = story.cues.reduce((last, cue, index) => (frame >= cue.start ? index : last), 0);
  return { enter, through, active };
}

function StoryPicture({ story, name, accent }: { story: VideoStory; name: string; accent: string }) {
  const frame = useCurrentFrame();
  switch (story.kind) {
    case 'user-manual': return <ManualScene story={story} accent={accent} beats={beatsAt(story, frame)} />;
    case 'course-intro': return <CourseScene story={story} accent={accent} beats={beatsAt(story, frame)} />;
    case 'article-summary': return <ArticleScene story={story} accent={accent} beats={beatsAt(story, frame)} />;
    default: return <ProductDemoPicture demo={story} name={name} accent={accent} />;
  }
}

/** The whole video for any type; an empty page when the script is missing. */
export function NarratedVideo({ scenes, accent, narrationUrl, music }: IntroProps) {
  const story = scenes.demo;
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  if (!story) return <AbsoluteFill style={{ background: '#f7f9fc' }} />;
  const cue = story.cues.find((entry) => frame >= entry.start && frame < entry.end);
  const musicVolume = (at: number) => {
    const speaking = story.cues.reduce((level, line) => Math.max(level,
      ease(at, line.start - 4, line.start) * (1 - ease(at, line.end, line.end + 8))), 0);
    return (.32 - .17 * speaking) * ease(at, 0, 5) * (1 - ease(at, durationInFrames - 10, durationInFrames));
  };
  return (
    <AbsoluteFill style={{ color: INK, fontFamily: SANS }}>
      <StoryPicture story={story} name={scenes.opening.name} accent={accent} />

      {cue && <div style={{ position: 'absolute', bottom: 44, left: 155, right: 155, padding: '13px 20px', borderRadius: 15, background: INK, color: 'white', fontSize: 25, fontWeight: 650, lineHeight: 1.25, textAlign: 'center' }}>{cue.text}</div>}
      <div style={{ position: 'absolute', left: 68, right: 68, bottom: 23, height: 2, background: '#d3dfef' }}>
        <div style={{ height: '100%', width: `${(frame + 1) / durationInFrames * 100}%`, background: accent }} />
      </div>
      {narrationUrl && <Audio src={narrationUrl} playbackRate={story.playbackRate} />}
      {music && <Audio src={MUSIC} volume={narrationUrl ? musicVolume : .32} />}
    </AbsoluteFill>
  );
}
