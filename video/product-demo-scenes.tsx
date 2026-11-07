import type { CSSProperties } from 'react';
import type { DemoVisual, ProductDemo } from '@/lib/domain/product-demo';
import { Glyph } from './parts';
import { mix, MONO } from './theme';

const TONES = {
  blue: '#2470bd',
  teal: '#087d6d',
  amber: '#a96116',
  violet: '#754fc2',
} satisfies Record<DemoVisual['tone'], string>;

export function demoTone(visual: DemoVisual): string {
  return TONES[visual.tone];
}

type SceneProps = {
  demo: ProductDemo;
  visual: DemoVisual;
  accent: string;
  input: number;
  action: number;
  result: number;
};

const label: CSSProperties = { fontFamily: MONO, fontSize: 14, letterSpacing: 2, textTransform: 'uppercase' };
const title: CSSProperties = { margin: 0, fontSize: 53, lineHeight: 1.07, letterSpacing: -1.7, overflowWrap: 'anywhere' };
const body: CSSProperties = { fontSize: 24, lineHeight: 1.35, overflowWrap: 'anywhere' };
const deviceGrid = [
  ...Array.from({ length: 31 }, (_, index) => `M${40 * (index + 1)} 0v720`),
  ...Array.from({ length: 17 }, (_, index) => `M0 ${40 * (index + 1)}h1280`),
].join(' ');

export function DemoScene(props: SceneProps) {
  switch (props.visual.layout) {
    case 'device': return <DeviceScene {...props} />;
    case 'conversation': return <ConversationScene {...props} />;
    case 'workflow': return <WorkflowScene {...props} />;
    case 'web-app': return null;
  }
}

const DEVICE_GLYPHS = {
  scan: 'M30 16H16v14m54-14h14v14M16 42v14h14m54-14v14H70M30 28h40v16H30z',
  adjust: 'M26 54a28 28 0 1 1 48 0M50 13v7M31 24l4 5m34-5-4 5',
  measure: 'M17 50h66M22 36v14m14-10v10m14-14v14m14-10v10m14-14v14',
  inspect: 'M55 21a16 16 0 1 0 0 23 16 16 0 0 0 0-23Zm1 23 15 15',
};

function DeviceReadout({ kind, progress, color }: { kind: NonNullable<DemoVisual['deviceAction']>; progress: number; color: string }) {
  return (
    <svg width="100" height="72" viewBox="0 0 100 72" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d={DEVICE_GLYPHS[kind]} />
      {kind === 'scan' && <path d="M21 17h58" style={{ translate: `0 ${38 * progress}px` }} />}
      {kind === 'adjust' && <path d="M50 42V24" transform={`rotate(${-58 + 116 * progress} 50 42)`} />}
      {kind === 'measure' && <path d="M22 27v28" style={{ translate: `${56 * progress}px 0` }} />}
    </svg>
  );
}

function DeviceScene({ demo, visual, accent, input, action, result }: SceneProps) {
  const glow = mix(demoTone(visual), '#ffffff', .45);
  return (
    <div style={{ position: 'absolute', inset: 0, color: '#f0f7fb', background: '#111b24' }}>
      <svg width="1280" height="720" viewBox="0 0 1280 720" style={{ position: 'absolute', inset: 0 }} aria-hidden="true">
        <path d={deviceGrid} stroke="#20303c" />
      </svg>
      <header style={{ position: 'absolute', top: 45, left: 64, right: 64 }}>
        <div style={{ ...label, color: glow, marginBottom: 17 }}>{visual.subject} / FIELD DEMO</div>
        <h1 style={title}>{demo.headline}</h1>
        <p style={{ ...body, margin: '13px 0 0', color: '#c3d4de' }}>{demo.summary}</p>
      </header>

      <div style={{ position: 'absolute', top: 258, left: 66, width: 340, padding: '21px 23px', borderLeft: `3px solid ${glow}`, background: '#1c2a34', opacity: input, translate: `${-24 * (1 - input)}px` }}>
        <div style={{ ...label, color: glow }}>{demo.steps[0]}</div>
        <strong style={{ display: 'block', marginTop: 12, fontSize: 29 }}>{demo.exampleTitle}</strong>
        <p style={{ ...body, margin: '9px 0 0', color: '#c3d4de' }}>{demo.exampleText}</p>
      </div>

      <div style={{ position: 'absolute', left: 460, top: 217, width: 300, height: 280, borderRadius: 36, border: '2px solid #5c7182', background: 'linear-gradient(145deg,#405364,#222f3b 66%)', boxShadow: '0 13px 0 #091219', padding: 24 }}>
        <div style={{ height: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ width: 10, height: 10, borderRadius: 8, background: action > 0 ? glow : '#6c8290' }} />
          <span style={{ ...label, letterSpacing: 1, fontSize: 12, color: '#c3d4de' }}>{visual.subject}</span>
        </div>
        <div style={{ position: 'relative', marginTop: 17, height: 145, display: 'grid', placeItems: 'center', borderRadius: 14, overflow: 'hidden', background: '#0c161e', border: '1px solid #6b8395' }}>
          <div style={{ display: 'grid', justifyItems: 'center', gap: 4, opacity: action > 0 ? 1 - result : 0 }}>
            <DeviceReadout kind={visual.deviceAction ?? 'inspect'} progress={action} color={glow} />
            <span style={{ ...label, color: glow }}>{demo.steps[1]}</span>
          </div>
          <span style={{ position: 'absolute', opacity: result }}><Glyph name="check" color={glow} size={46} /></span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 9, marginTop: 19 }}>
          {[0, 1, 2].map((index) => <span key={index} style={{ width: 21, height: 5, borderRadius: 4, background: '#748895' }} />)}
        </div>
      </div>

      <div style={{ position: 'absolute', left: 815, right: 64, top: 258, padding: '21px 23px', border: `1px solid ${glow}`, borderRadius: 18, background: '#172a34', opacity: result, translate: `${25 * (1 - result)}px` }}>
        <div style={{ ...label, color: glow }}>{demo.steps[2]}</div>
        <p style={{ ...body, fontSize: 31, margin: '14px 0 0' }}>{demo.result}</p>
      </div>
      <StepRail demo={demo} progress={[input, action, result]} style={{ color: '#dce8ef', top: 543 }} accent={accent} />
    </div>
  );
}

function ConversationScene({ demo, visual, accent, input, action, result }: SceneProps) {
  const tone = demoTone(visual);
  const paper = mix(tone, '#ffffff', .08);
  const bubble = mix(tone, '#ffffff', .16);
  return (
    <div style={{ position: 'absolute', inset: 0, color: '#1f2a38', background: paper }}>
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: 511, background: bubble }} />
      <div style={{ position: 'absolute', top: 62, left: 65, right: 65, ...label, color: tone }}>{visual.subject} / Q&A</div>
      <div style={{ position: 'absolute', top: 176, left: 65, width: 380 }}>
        <h1 style={title}>{demo.headline}</h1>
        <p style={{ ...body, marginTop: 21 }}>{demo.summary}</p>
      </div>
      <div style={{ position: 'absolute', top: 148, left: 573, right: 64 }}>
        <div style={{ marginLeft: 75, padding: '20px 25px', background: bubble, borderRadius: '26px 26px 7px 26px', opacity: input, translate: `0 ${15 * (1 - input)}px` }}>
          <div style={{ ...label, color: tone }}>{demo.steps[0]}</div>
          <div style={{ ...body, marginTop: 9, fontSize: 28, fontWeight: 650 }}>{demo.exampleText}</div>
        </div>
        <div style={{ margin: '17px 0', color: tone, ...label, opacity: action }}>{demo.steps[1]} · {demo.exampleTitle}</div>
        <div style={{ marginRight: 70, padding: '20px 25px', background: '#ffffff', borderLeft: `4px solid ${accent}`, borderRadius: '7px 26px 26px 26px', opacity: result, translate: `0 ${15 * (1 - result)}px` }}>
          <div style={{ ...label, color: tone }}>{demo.steps[2]}</div>
          <div style={{ ...body, marginTop: 9, fontSize: 28, fontWeight: 650 }}>{demo.result}</div>
        </div>
      </div>
      <StepRail demo={demo} progress={[input, action, result]} style={{ top: 543 }} accent={accent} />
    </div>
  );
}

function WorkflowScene({ demo, visual, accent, input, action, result }: SceneProps) {
  const tone = demoTone(visual);
  const cards = [demo.exampleText, null, demo.result];
  const progress = [input, action, result];
  return (
    <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(180deg,${mix(tone, '#ffffff', .16)},#ffffff)`, color: '#1d2433' }}>
      <header style={{ position: 'absolute', top: 54, left: 65, right: 65 }}>
        <div style={{ ...label, color: tone, marginBottom: 21 }}>{visual.subject} / PROCESS</div>
        <h1 style={title}>{demo.headline}</h1>
        <p style={{ ...body, margin: '14px 0 0' }}>{demo.summary}</p>
      </header>
      <div style={{ position: 'absolute', left: 65, right: 65, top: 267, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 24 }}>
        {demo.steps.map((step, index) => {
          const active = progress[index]!;
          return (
            <div key={index} style={{ minWidth: 0, minHeight: 229, background: '#fff', borderTop: `5px solid ${mix(accent, '#dce4eb', active)}`, borderRadius: 15, padding: 23, boxShadow: '0 10px 28px #1d243312' }}>
              <div style={{ ...label, color: tone }}>0{index + 1}</div>
              <h2 style={{ fontSize: 29, lineHeight: 1.12, margin: '15px 0 0', overflowWrap: 'anywhere' }}>{step}</h2>
              <div style={{ ...body, fontSize: 22, marginTop: 15, opacity: active }}>
                {index === 0 && <strong>{demo.exampleTitle}<br /></strong>}
                {cards[index] ?? <Glyph name="arrow" color={accent} size={36} style={{ translate: `${16 * active}px` }} />}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StepRail({ demo, progress, style, accent }: { demo: ProductDemo; progress: number[]; style: CSSProperties; accent: string }) {
  return (
    <div style={{ position: 'absolute', left: 64, right: 64, display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 17, ...style }}>
      {demo.steps.map((step, index) => (
        <div key={index} style={{ borderTop: `2px solid ${mix(accent, '#8495a4', progress[index]!)}`, paddingTop: 11, fontSize: 18, fontWeight: 650, opacity: .65 + .35 * progress[index]! }}>
          <span style={{ fontFamily: MONO, marginRight: 12 }}>0{index + 1}</span>{step}
        </div>
      ))}
    </div>
  );
}
