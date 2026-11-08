import { VIDEO_FRAMES, type VideoTemplate } from '@/lib/constants';
import { picoUsd, providerTotal } from '@/lib/domain/provider-cost';

export const PRODUCT_DEMO_TEMPLATE = 'product-demo';
/** The four spoken lines of every narrated video, in order: the opening and three beats. */
export const DEMO_LINE_LIMITS = [70, 76, 76, 76] as const;
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
  const maxChars = DEMO_LINE_LIMITS.reduce((sum, length) => sum + length + Math.floor(length / 5), 0);
  return scriptCredits + providerTotal([{ costUsd: demoSpeechCost(rate, maxChars) }]).credits;
}

export interface DemoCue {
  text: string;
  /** Frame interval at 24 fps, end exclusive. */
  start: number;
  end: number;
}

/** What every narrated video has: its title, the three beat labels and the voiceover. */
interface NarratedStory {
  headline: string;
  summary: string;
  /** Short labels for the three beats after the opening. */
  steps: [string, string, string];
  cues: DemoCue[];
  /** An immutable private asset, replaced only by another successful generation. */
  audioId: string;
  playbackRate: number;
}

/** Product demo: what the product is, the input, the action, the live result. */
export interface ProductDemo extends NarratedStory {
  /** Absent on demos made before the other video types. */
  kind?: 'product-demo';
  /** Absent on demos made before the generated visual direction. */
  visual?: DemoVisual;
  exampleTitle: string;
  exampleText: string;
  result: string;
}

/** User manual: the device, setting it up, the main operation, one caution or fix. */
export interface ManualStory extends NarratedStory {
  kind: 'user-manual';
  subject: string;
  setup: string[];
  operation: { title: string; detail: string };
  caution: { title: string; text: string };
}

/** Course introduction: the promise, who it is for, the modules, what learners leave with. */
export interface CourseStory extends NarratedStory {
  kind: 'course-intro';
  course: string;
  badges: string[];
  audience: string[];
  modules: string[];
  outcomes: string[];
  cta: string;
}

/** Article summary: the thesis, three key points, one piece of evidence, the takeaway. */
export interface ArticleStory extends NarratedStory {
  kind: 'article-summary';
  source: string;
  points: string[];
  evidence: { figure: string; text: string };
  conclusion: string;
  further: string[];
}

export type VideoStory = ProductDemo | ManualStory | CourseStory | ArticleStory;

/** The video type a story was written for; demos made before the other types are product demos. */
export function storyTemplate(story: VideoStory): VideoTemplate {
  return story.kind ?? PRODUCT_DEMO_TEMPLATE;
}

const RECOMMENDATIONS: { template: VideoTemplate; pattern: RegExp }[] = [
  { template: 'user-manual', pattern: /\b(manuals?|handbook|user guide|quick ?start|datasheet|installation guide|troubleshooting)\b|说明书|手册|使用说明|操作指南|安装指南|快速入门/i },
  { template: 'course-intro', pattern: /\b(courses?|lessons?|lectures?|syllabus|curriculum|bootcamp|workshop|tutorials?)\b|课程|课件|讲义|教程|培训|训练营|大纲/i },
  { template: 'article-summary', pattern: /\b(blog|blogs|articles?|essays?|newsletters?)\b|文章|博客|随笔|专栏|观点/i },
];

/**
 * The type the editor preselects for a Ree that has no video yet, from its
 * name, introduction and knowledge titles: a manual, a course, then
 * articles (also when most sources are web pages); a product demo otherwise.
 * The owner can always pick another.
 */
export function recommendedTemplate(input: { name: string; description: string; titles: string[]; kinds: string[] }): VideoTemplate {
  const text = [input.name, input.description, ...input.titles].join('\n');
  const match = RECOMMENDATIONS.find(({ pattern }) => pattern.test(text));
  if (match) return match.template;
  const pages = input.kinds.filter((kind) => kind === 'page' || kind === 'site').length;
  if (input.kinds.length > 0 && pages * 2 > input.kinds.length) return 'article-summary';
  return PRODUCT_DEMO_TEMPLATE;
}

export function narrationPath(reeId: string, audioId: string): string {
  return `video-narration/${reeId}/${audioId}.wav`;
}

export function demoTimeline(demo: VideoStory): { start: number; end: number }[] {
  return demo.cues.map((cue, index) => ({
    start: index === 0 ? 0 : cue.start,
    end: demo.cues[index + 1]?.start ?? VIDEO_FRAMES,
  }));
}

