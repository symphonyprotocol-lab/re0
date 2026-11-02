/**
 * A Ree's 15-second introduction (rebuild-proposal.md 2.6): one Remotion
 * composition shared by `@remotion/player` (playback on the public page,
 * cards and the editor) and `@remotion/web-renderer` (the owner's MP4
 * export), so both draw the same frames from the same props. Four shots --
 * who it is, what it knows, a real answer, how to ask -- of 3, 4, 5 and 3
 * seconds with 0.4-second crossfades inside those lengths. Built along the
 * remotion-markup skill: animation from `useCurrentFrame()` and
 * `interpolate()` only, no CSS transitions.
 */
import type { ComponentType } from 'react';
import { Audio } from '@remotion/media';
import { AbsoluteFill, Easing, interpolate, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { VIDEO_FPS, VIDEO_FRAMES, type VideoAspect } from '@/lib/constants';
import { introSize, scriptLang, shotAt, shotWindows, type IntroProps } from '@/lib/domain/video';
import { Avatar, Backdrop, Chrome, Glyph, QrCode, ShotFade, shotSpan, useEntrance, useUnit } from './parts';
import { MONO, mix, PALETTES, SANS, type Palette } from './theme';

/** The built-in music (video/music/generate.mts), served from `public/`. */
export const INTRO_MUSIC = '/video/intro-music.wav';

const CAPTIONS = {
  zh: {
    knows: '我知道的，从这里来。',
    more: (n: number) => `等 ${n} 项知识`,
    perAnswer: 'credits / 次成功回答',
    ask: '扫码或打开链接，问它',
  },
  en: {
    knows: 'My knowledge starts here.',
    more: (n: number) => `and ${n} more sources`,
    perAnswer: 'credits / answer',
    ask: 'Scan or open the link to ask',
  },
};

type Captions = (typeof CAPTIONS)['zh'];

interface ShotProps {
  props: IntroProps;
  palette: Palette;
  captions: Captions;
}

function Eyebrow({ text, palette }: { text: string; palette: Palette }) {
  const u = useUnit();
  return <span style={{ fontFamily: MONO, fontSize: 14 * u, letterSpacing: 3 * u, color: palette.faint }}>{text}</span>;
}

function Column({ children, gap }: { children: React.ReactNode; gap: number }) {
  const u = useUnit();
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: `${110 * u}px ${80 * u}px`, fontFamily: SANS }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap, width: '100%' }}>{children}</div>
    </AbsoluteFill>
  );
}

/** Shot 1: the name and its positioning. Fully drawn on frame 0 -- the link preview is this frame. */
function Opening({ props, palette }: ShotProps) {
  const frame = useCurrentFrame();
  const u = useUnit();
  const { opening } = props.scenes;
  return (
    <Column gap={22 * u}>
      <Eyebrow text="MEET YOUR KNOWLEDGE COMPANION" palette={palette} />
      <div style={{ scale: String(interpolate(frame, [0, 72], [1, 1.06], { extrapolateRight: 'clamp' })) }}>
        <Avatar url={props.ree.avatarUrl} color={props.ree.color} accent={props.accent} size={112 * u} />
      </div>
      <h1 style={{ margin: 0, fontFamily: palette.titleFont, fontSize: 68 * u, lineHeight: 1.25, fontWeight: palette.titleFont === SANS ? 600 : 400, letterSpacing: -1.5 * u, color: palette.title }}>{opening.name}</h1>
      <div
        style={{
          height: 4 * u,
          borderRadius: 4 * u,
          backgroundColor: props.accent,
          width: `${interpolate(frame, [0, 40], [22, 64], { extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) })}%`,
          maxWidth: 420 * u,
        }}
      />
      <p style={{ margin: 0, fontSize: 30 * u, lineHeight: 1.6, color: palette.body }}>{opening.position}</p>
    </Column>
  );
}

function SourceRow({ title, index, palette, accent }: { title: string; index: number; palette: Palette; accent: string }) {
  const u = useUnit();
  const frame = useCurrentFrame();
  const delay = 14 + index * 7;
  const progress = interpolate(frame, [delay, delay + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const checked = interpolate(frame, [delay + 12, delay + 20], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18 * u,
        padding: `${18 * u}px ${24 * u}px`,
        borderRadius: 12 * u,
        border: `${Math.max(1, 1.5 * u)}px solid ${palette.cardBorder}`,
        backgroundColor: palette.card,
        opacity: progress,
        translate: `${(1 - progress) * 120 * u}px 0px`,
      }}
    >
      <Glyph name="file" color={mix(accent, palette.body, 0.5)} size={30 * u} />
      <span style={{ flex: 1, textAlign: 'left', fontSize: 26 * u, color: palette.title }}>{title}</span>
      <Glyph name="check" color={accent} size={26 * u} style={{ opacity: checked }} />
    </div>
  );
}

/** Shot 2: up to four sources fly in one by one; more show as "等 N 项". */
function Sources({ props, palette, captions }: ShotProps) {
  const u = useUnit();
  const heading = useEntrance(4);
  const { titles } = props.scenes.sources;
  const more = Math.max(0, props.ree.sourcesTotal - titles.length);
  const tail = useEntrance(14 + titles.length * 7 + 6);
  return (
    <Column gap={16 * u}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 * u, opacity: heading.opacity, translate: heading.translate }}>
        <Eyebrow text="KNOWLEDGE, WITH REAL SOURCES" palette={palette} />
        <h2 style={{ margin: `0 0 ${14 * u}px`, fontFamily: palette.titleFont, fontSize: 48 * u, fontWeight: palette.titleFont === SANS ? 600 : 400, color: palette.title, letterSpacing: -1 * u }}>{captions.knows}</h2>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 * u, width: '100%', maxWidth: 640 * u }}>
        {titles.map((title, index) => (
          <SourceRow key={index} title={title} index={index} palette={palette} accent={props.accent} />
        ))}
      </div>
      {more > 0 && <span style={{ fontSize: 22 * u, color: palette.body, opacity: tail.opacity }}>{captions.more(more)}</span>}
    </Column>
  );
}

/** The answer appears a few characters a frame, like a reply arriving. */
function TypedAnswer({ text, start, palette, accent }: { text: string; start: number; palette: Palette; accent: string }) {
  const frame = useCurrentFrame();
  const u = useUnit();
  const letters = Array.from(text);
  const shown = Math.round(interpolate(frame, [start, start + Math.max(18, letters.length * 1.1)], [0, letters.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  return (
    <div style={{ display: 'flex', gap: 16 * u, alignSelf: 'flex-start', textAlign: 'left', maxWidth: '92%' }}>
      <Glyph name="sparkle" color={accent} size={34 * u} style={{ marginTop: 6 * u, opacity: frame >= start ? 1 : 0 }} />
      <p style={{ margin: 0, fontSize: 32 * u, lineHeight: 1.65, color: palette.title }}>
        {/* The full text stays in the layout so the paragraph does not reflow as it types. */}
        <span>{letters.slice(0, shown).join('')}</span>
        <span style={{ color: 'transparent' }}>{letters.slice(shown).join('')}</span>
      </p>
    </div>
  );
}

/** Shot 3: one real question and the first sentence of its answer, with its source. */
function Answer({ props, palette }: ShotProps) {
  const u = useUnit();
  const heading = useEntrance(2);
  const question = useEntrance(10, 14);
  const citation = useEntrance(76);
  const { answer } = props.scenes;
  return (
    <Column gap={26 * u}>
      <div style={{ opacity: heading.opacity, translate: heading.translate }}>
        <Eyebrow text="ONE QUESTION. A GROUNDED ANSWER." palette={palette} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 * u, width: '100%', maxWidth: 820 * u }}>
        <div
          style={{
            alignSelf: 'flex-end',
            maxWidth: '86%',
            padding: `${20 * u}px ${28 * u}px`,
            borderRadius: `${20 * u}px ${20 * u}px ${6 * u}px ${20 * u}px`,
            backgroundColor: mix(props.accent, palette.bubbleBase, 0.14),
            color: palette.bubbleInk,
            fontSize: 30 * u,
            lineHeight: 1.55,
            textAlign: 'left',
            opacity: question.opacity,
            translate: question.translate,
          }}
        >
          {answer.question}
        </div>
        <TypedAnswer text={answer.answer} start={30} palette={palette} accent={props.accent} />
        <div
          style={{
            alignSelf: 'flex-start',
            display: 'flex',
            alignItems: 'center',
            gap: 10 * u,
            marginLeft: 50 * u,
            padding: `${8 * u}px ${14 * u}px`,
            borderRadius: 8 * u,
            border: `${Math.max(1, 1.5 * u)}px solid ${palette.cardBorder}`,
            backgroundColor: palette.card,
            fontSize: 18 * u,
            color: palette.body,
            opacity: citation.opacity,
            translate: citation.translate,
          }}
        >
          <span style={{ fontFamily: MONO, color: props.accent }}>[1]</span>
          <Glyph name="file" color={palette.body} size={20 * u} />
          {props.scenes.sources.titles[0]}
        </div>
      </div>
    </Column>
  );
}

/** Shot 4: the call to action, the price, and the way in -- a QR code and the link while public. */
function Closing({ props, palette, captions }: ShotProps) {
  const u = useUnit();
  const { width, height } = useVideoConfig();
  const lead = useEntrance(4);
  const price = useEntrance(12);
  const link = useEntrance(20);
  const portrait = height > width;
  const path = props.ree.shareUrl ? props.ree.shareUrl.replace(/^https?:\/\//, '') : `re0 / r / ${props.ree.slug}`;
  return (
    <Column gap={20 * u}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 * u, opacity: lead.opacity, translate: lead.translate }}>
        <Eyebrow text="YOUR NEXT QUESTION STARTS HERE" palette={palette} />
        <Avatar url={props.ree.avatarUrl} color={props.ree.color} accent={props.accent} size={84 * u} />
        <h2 style={{ margin: 0, fontFamily: palette.titleFont, fontSize: 56 * u, fontWeight: palette.titleFont === SANS ? 600 : 400, color: palette.title, letterSpacing: -1 * u }}>{props.scenes.closing.cta}</h2>
      </div>
      <p style={{ margin: 0, fontFamily: MONO, fontSize: 40 * u, color: props.accent, opacity: price.opacity, translate: price.translate }}>
        {props.ree.price.toLocaleString('en-US')} <span style={{ fontFamily: SANS, fontSize: 20 * u, color: palette.body }}>{captions.perAnswer}</span>
      </p>
      <div style={{ display: 'flex', flexDirection: portrait ? 'column' : 'row', alignItems: 'center', gap: 22 * u, marginTop: 8 * u, opacity: link.opacity, translate: link.translate }}>
        {props.ree.shareUrl && <QrCode url={props.ree.shareUrl} size={(portrait ? 200 : 132) * u} ink="#0b1a4a" />}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: portrait || !props.ree.shareUrl ? 'center' : 'flex-start', gap: 10 * u }}>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10 * u,
              padding: `${12 * u}px ${22 * u}px`,
              borderRadius: 10 * u,
              backgroundColor: props.accent,
              color: '#ffffff',
              fontSize: 22 * u,
              fontWeight: 600,
            }}
          >
            {captions.ask}
            <Glyph name="arrow" color="#ffffff" size={22 * u} />
          </span>
          <span style={{ fontFamily: MONO, fontSize: 18 * u, letterSpacing: 1 * u, color: palette.faint }}>{path}</span>
        </div>
      </div>
    </Column>
  );
}

const SHOTS: ComponentType<ShotProps>[] = [Opening, Sources, Answer, Closing];

function ChromeAtFrame({ palette, props }: { palette: Palette; props: IntroProps }) {
  const frame = useCurrentFrame();
  return <Chrome palette={palette} accent={props.accent} music={props.music} shot={shotAt(frame)} />;
}

function Music() {
  const { durationInFrames, fps } = useVideoConfig();
  return (
    <Audio
      src={INTRO_MUSIC}
      volume={(frame: number) => interpolate(frame, [0, 0.5 * fps, durationInFrames - 1.2 * fps, durationInFrames], [0, 0.8, 0.8, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
    />
  );
}

export function ReeIntro(props: IntroProps) {
  const palette = PALETTES[props.template] ?? PALETTES.editorial;
  const captions = CAPTIONS[scriptLang(props.scenes)];
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ backgroundColor: palette.background }}>
      <Backdrop palette={palette} accent={props.accent} />
      {shotWindows().map((window, index) => {
        const Shot = SHOTS[index]!;
        const span = shotSpan(window.start, window.end, durationInFrames);
        return (
          <Sequence key={index} name={`Shot ${index + 1}`} from={span.from} durationInFrames={span.durationInFrames}>
            <ShotFade first={span.first} last={span.last} length={span.durationInFrames}>
              <Shot props={props} palette={palette} captions={captions} />
            </ShotFade>
          </Sequence>
        );
      })}
      <ChromeAtFrame palette={palette} props={props} />
      {props.music && <Music />}
    </AbsoluteFill>
  );
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
