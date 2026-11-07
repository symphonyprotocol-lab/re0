import { VIDEO_FRAMES } from '@/lib/constants';
import { picoUsd, providerTotal } from '@/lib/domain/provider-cost';

export const PRODUCT_DEMO_TEMPLATE = 'product-demo';
export const DEMO_LINE_LIMITS = { hook: 70, prepare: 76, action: 76, result: 76 } as const;
export const DEMO_LAYOUTS = ['web-app', 'device', 'conversation', 'workflow'] as const;
export const DEMO_TONES = ['blue', 'teal', 'amber', 'violet'] as const;
export const DEMO_DEVICE_ACTIONS = ['scan', 'adjust', 'measure', 'inspect'] as const;

export interface DemoVisual {
  layout: (typeof DEMO_LAYOUTS)[number];
  tone: (typeof DEMO_TONES)[number];
  subject: string;
  deviceAction?: (typeof DEMO_DEVICE_ACTIONS)[number];
}

// USD per million input characters from the AI Gateway model catalog.
const SPEECH_RATES = new Map([['openai/tts-1', 15], ['openai/tts-1-hd', 30]]);

export function demoSpeechRate(model: string): number | undefined {
  return SPEECH_RATES.get(model);
}

export function demoSpeechText(line: string): string {
  return line.replace(/\bAPAGE\b/g, 'A Page');
}

export function demoSpeechCost(rate: number, characters: number): string {
  return picoUsd(BigInt(rate * characters) * 1_000_000n);
}

export function demoGenerationLimit(rate: number, scriptCredits: number): number {
  // Spelling out APAGE can add one character per five original characters.
  const maxChars = Object.values(DEMO_LINE_LIMITS).reduce((sum, length) => sum + length + Math.floor(length / 5), 0);
  return scriptCredits + providerTotal([{ costUsd: demoSpeechCost(rate, maxChars) }]).credits;
}

export interface DemoCue {
  text: string;
  /** Frame interval at 24 fps, end exclusive. */
  start: number;
  end: number;
}

export interface ProductDemo {
  /** Absent on demos made before the generated visual direction. */
  visual?: DemoVisual;
  headline: string;
  summary: string;
  exampleTitle: string;
  exampleText: string;
  result: string;
  steps: [string, string, string];
  cues: DemoCue[];
  /** An immutable private asset, replaced only by another successful generation. */
  audioId: string;
  playbackRate: number;
}

export function narrationPath(reeId: string, audioId: string): string {
  return `video-narration/${reeId}/${audioId}.wav`;
}

export function demoTimeline(demo: ProductDemo): { start: number; end: number }[] {
  return demo.cues.map((cue, index) => ({
    start: index === 0 ? 0 : cue.start,
    end: demo.cues[index + 1]?.start ?? VIDEO_FRAMES,
  }));
}

