/**
 * The pictures of the user manual, course introduction and article summary
 * videos (1280×720). Each shows its opening at once and brings in one panel
 * per beat as the voiceover reaches it; everything stays above the captions
 * (y < 590). Progress comes in from the shared narrated frame, so a still
 * at frame 0 shows the opening with the panels faded back.
 */
import type { CSSProperties } from 'react';
import type { ArticleStory, CourseStory, ManualStory } from '@/lib/domain/product-demo';
import { Glyph } from './parts';
import { mix, MONO, SERIF } from './theme';

export interface Beats {
  /** Each beat's entrance, 0 to 1 over its first half second. */
  enter: [number, number, number];
  /** How far each beat's line has been spoken, 0 to 1. */
  through: [number, number, number];
  /** The spoken line now: 0 the opening, 1-3 the beats. */
  active: number;
}

type SceneProps<S> = { story: S; accent: string; beats: Beats };

const label: CSSProperties = { fontFamily: MONO, fontSize: 14, letterSpacing: 2, textTransform: 'uppercase' };
const clip: CSSProperties = { overflowWrap: 'anywhere', minWidth: 0 };
/** A panel waiting for its beat sits faded back, then rises into place. */
const rise = (progress: number): CSSProperties => ({ opacity: .34 + .66 * progress, translate: `0 ${14 * (1 - progress)}px` });
/** The `index`-th of `count` items, revealed in turn as the line is spoken. */
const step = (through: number, index: number, count: number) => Math.min(1, Math.max(0, through * count * 1.25 - index));

function BeatLabel({ index, text, color }: { index: number; text: string; color: string }) {
  return <div style={{ ...label, color, display: 'flex', gap: 10, ...clip }}><span>0{index + 1}</span><span>{text}</span></div>;
}

/* ------------------------------------------------------------ user manual */

export function ManualScene({ story, accent, beats }: SceneProps<ManualStory>) {
  const ink = '#172233';
  const muted = '#566579';
  const amber = { ink: '#7a4a0b', paper: '#fff5e3', line: '#efc27c' };
  const panel = (index: number): CSSProperties => ({
    ...rise(beats.enter[index]!), minWidth: 0, minHeight: 262, borderRadius: 16, padding: '20px 22px',
    background: '#ffffff', border: `1.5px solid ${beats.active === index + 1 ? accent : '#dbe3ed'}`, boxShadow: '0 12px 30px #1722330f',
  });
  return (
    <div style={{ position: 'absolute', inset: 0, color: ink, background: 'linear-gradient(180deg,#f7f9fc,#edf1f6)' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 10, background: accent }} />
      <header style={{ position: 'absolute', top: 44, left: 64, right: 64 }}>
        <div style={{ ...label, color: accent, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Glyph name="book" color={accent} size={20} />{story.subject} / QUICK START
        </div>
        <h1 style={{ margin: '16px 0 0', fontSize: 50, lineHeight: 1.08, letterSpacing: -1.5, ...clip }}>{story.headline}</h1>
        <p style={{ margin: '12px 0 0', fontSize: 23, lineHeight: 1.35, color: muted, ...clip }}>{story.summary}</p>
      </header>
      <div style={{ position: 'absolute', top: 262, left: 64, right: 64, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 24, alignItems: 'start' }}>
        <div style={panel(0)}>
          <BeatLabel index={0} text={story.steps[0]} color={accent} />
          <ol style={{ listStyle: 'none', margin: '16px 0 0', padding: 0, display: 'grid', gap: 13 }}>
            {story.setup.map((item, index) => {
              const done = step(beats.through[0], index, story.setup.length);
              return (
                <li key={index} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', fontSize: 20, lineHeight: 1.3, ...clip }}>
                  <span style={{ flex: 'none', width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', border: `1.5px solid ${mix(accent, '#c8d2de', done)}`, background: mix(accent, '#ffffff', done) }}>
                    <Glyph name="check" color="#ffffff" size={18} style={{ opacity: done }} />
                  </span>
                  <span>{item}</span>
                </li>
              );
            })}
          </ol>
        </div>
        <div style={{ ...panel(1), boxShadow: `inset 5px 0 0 ${accent}, 0 12px 30px #1722330f` }}>
          <BeatLabel index={1} text={story.steps[1]} color={accent} />
          <strong style={{ display: 'block', marginTop: 14, fontSize: 26, lineHeight: 1.18, ...clip }}>{story.operation.title}</strong>
          <p style={{ margin: '10px 0 0', fontSize: 20, lineHeight: 1.38, color: muted, ...clip }}>{story.operation.detail}</p>
        </div>
        <div style={{ ...panel(2), background: amber.paper, border: `1.5px solid ${beats.active === 3 ? amber.ink : amber.line}`, color: amber.ink }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Glyph name="alert" color={amber.ink} size={24} />
            <BeatLabel index={2} text={story.steps[2]} color={amber.ink} />
          </div>
          <strong style={{ display: 'block', marginTop: 14, fontSize: 26, lineHeight: 1.18, ...clip }}>{story.caution.title}</strong>
          <p style={{ margin: '10px 0 0', fontSize: 20, lineHeight: 1.38, ...clip }}>{story.caution.text}</p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ course introduction */

export function CourseScene({ story, accent, beats }: SceneProps<CourseStory>) {
  const ink = '#1f1b38';
  const muted = '#5d5872';
  const section = (index: number): CSSProperties => ({ ...rise(beats.enter[index]!), paddingTop: index ? 16 : 0, borderTop: index ? '1px solid #e7e3f0' : undefined });
  return (
    <div style={{ position: 'absolute', inset: 0, color: ink, background: `linear-gradient(125deg,#fbf8f3,${mix(accent, '#ffffff', .13)})` }}>
      <div style={{ position: 'absolute', top: 56, left: 64, width: 500 }}>
        <div style={{ ...label, color: accent, ...clip }}>COURSE / {story.course}</div>
        <h1 style={{ margin: '22px 0 0', fontSize: 54, lineHeight: 1.06, letterSpacing: -1.8, ...clip }}>{story.headline}</h1>
        <p style={{ margin: '18px 0 0', fontSize: 23, lineHeight: 1.4, color: muted, ...clip }}>{story.summary}</p>
        {story.badges.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 24 }}>
            {story.badges.map((badge, index) => (
              <span key={index} style={{ padding: '7px 14px', borderRadius: 20, background: '#ffffff', border: `1px solid ${mix(accent, '#ffffff', .3)}`, fontSize: 17, fontWeight: 650, ...clip }}>{badge}</span>
            ))}
          </div>
        )}
      </div>
      <div style={{ position: 'absolute', left: 64, top: 512, ...rise(beats.enter[2]), display: 'inline-flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderRadius: 12, background: accent, color: '#ffffff', fontSize: 20, fontWeight: 700, transform: `scale(${1 + .04 * beats.enter[2] * (1 - beats.through[2])})`, transformOrigin: 'left center' }}>
        {story.cta}<Glyph name="arrow" color="#ffffff" size={20} />
      </div>

      <div style={{ position: 'absolute', top: 48, left: 620, right: 64, bottom: 138, padding: '22px 26px', borderRadius: 20, background: '#ffffff', boxShadow: '0 16px 40px #1f1b3814', display: 'grid', alignContent: 'start', gap: 16 }}>
        <div style={section(0)}>
          <BeatLabel index={0} text={story.steps[0]} color={accent} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
            {story.audience.map((who, index) => (
              <span key={index} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 13px', borderRadius: 10, background: mix(accent, '#ffffff', .1), fontSize: 18, fontWeight: 600, opacity: .4 + .6 * step(beats.through[0], index, story.audience.length), ...clip }}>
                <Glyph name="user" color={accent} size={18} />{who}
              </span>
            ))}
          </div>
        </div>
        <div style={section(1)}>
          <BeatLabel index={1} text={story.steps[1]} color={accent} />
          <ol style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 9 }}>
            {story.modules.map((module, index) => {
              const lit = step(beats.through[1], index, story.modules.length);
              return (
                <li key={index} style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 20, fontWeight: 650, color: mix(ink, '#a19cb3', .35 + .65 * lit), ...clip }}>
                  <span style={{ flex: 'none', width: 40, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', fontFamily: MONO, fontSize: 14, background: mix(accent, '#efedf5', lit), color: lit > .5 ? '#ffffff' : muted }}>M{index + 1}</span>
                  {module}
                </li>
              );
            })}
          </ol>
        </div>
        <div style={section(2)}>
          <BeatLabel index={2} text={story.steps[2]} color={accent} />
          <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 8 }}>
            {story.outcomes.map((outcome, index) => (
              <li key={index} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 19, lineHeight: 1.3, opacity: .4 + .6 * step(beats.through[2], index, story.outcomes.length), ...clip }}>
                <Glyph name="check" color={accent} size={22} />{outcome}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ article summary */

export function ArticleScene({ story, accent, beats }: SceneProps<ArticleStory>) {
  const ink = '#24211c';
  const muted = '#6c665b';
  const card: CSSProperties = { borderRadius: 16, padding: '20px 22px', background: '#ffffff', border: '1px solid #e6e0d4', boxShadow: '0 12px 30px #24211c0d', minWidth: 0 };
  return (
    <div style={{ position: 'absolute', inset: 0, color: ink, background: '#faf8f4' }}>
      <div style={{ position: 'absolute', top: 50, left: 64, width: 720, ...label, color: accent, ...clip }}>ARTICLE SUMMARY / {story.source}</div>
      <Glyph name="quote" color={accent} size={42} style={{ position: 'absolute', top: 96, left: 60 }} />
      <div style={{ position: 'absolute', top: 92, left: 118, width: 650 }}>
        <h1 style={{ margin: 0, fontFamily: SERIF, fontSize: 42, lineHeight: 1.16, fontWeight: 600, letterSpacing: -.6, ...clip }}>{story.headline}</h1>
        <p style={{ margin: '14px 0 0', fontSize: 21, lineHeight: 1.38, color: muted, ...clip }}>{story.summary}</p>
      </div>

      <div style={{ position: 'absolute', top: 50, left: 828, right: 64, ...rise(beats.enter[0]) }}>
        <BeatLabel index={0} text={story.steps[0]} color={accent} />
        <ol style={{ listStyle: 'none', margin: '16px 0 0', padding: 0, display: 'grid', gap: 16 }}>
          {story.points.map((point, index) => {
            const shown = step(beats.through[0], index, story.points.length);
            return (
              <li key={index} style={{ display: 'flex', gap: 14, alignItems: 'flex-start', paddingBottom: 14, borderBottom: '1px solid #e6e0d4', opacity: .3 + .7 * shown, translate: `${10 * (1 - shown)}px 0` }}>
                <span style={{ flex: 'none', fontFamily: SERIF, fontSize: 30, lineHeight: 1, color: accent }}>{index + 1}</span>
                <span style={{ fontSize: 20, lineHeight: 1.32, fontWeight: 600, ...clip }}>{point}</span>
              </li>
            );
          })}
        </ol>
      </div>

      <div style={{ position: 'absolute', top: 336, left: 64, width: 336, ...card, ...rise(beats.enter[1]), borderTop: `4px solid ${accent}` }}>
        <BeatLabel index={1} text={story.steps[1]} color={accent} />
        <div style={{ marginTop: 8, fontFamily: SERIF, fontSize: story.evidence.figure.length > 7 ? 40 : 60, lineHeight: 1.05, fontWeight: 700, color: accent, ...clip }}>{story.evidence.figure}</div>
        <p style={{ margin: '8px 0 0', fontSize: 18, lineHeight: 1.35, color: muted, ...clip }}>{story.evidence.text}</p>
      </div>
      <div style={{ position: 'absolute', top: 336, left: 424, width: 372, ...card, ...rise(beats.enter[2]), background: mix(accent, '#ffffff', .07) }}>
        <BeatLabel index={2} text={story.steps[2]} color={accent} />
        <p style={{ margin: '10px 0 0', fontSize: 21, lineHeight: 1.36, fontWeight: 650, ...clip }}>{story.conclusion}</p>
        {story.further.length > 0 && (
          <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 6 }}>
            {story.further.map((title, index) => (
              <li key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, color: muted, ...clip }}>
                <Glyph name="book" color={accent} size={17} />{title}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
