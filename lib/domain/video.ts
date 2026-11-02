/**
 * A Ree's 15-second introduction without the database (rebuild-proposal.md
 * 2.6, prototype suite.js `videoEditor`): the four shots and their character
 * limits, the shot timeline, what an export costs, and the props the
 * Remotion composition in `video/` draws. Shared by the server (script
 * generation, export cache identity), the editor and the composition.
 */
import {
  VIDEO_ASPECTS,
  VIDEO_DEFAULT_ACCENT,
  VIDEO_EXPORT_CREDITS,
  VIDEO_FPS,
  VIDEO_FRAMES,
  VIDEO_LIMITS,
  VIDEO_LONG_SIDE,
  VIDEO_SHORT_SIDE,
  VIDEO_SHOT_SECONDS,
  VIDEO_TEMPLATES,
  type VideoAspect,
  type VideoTemplate,
} from '@/lib/constants';

/** The text of the four shots. */
export interface VideoScenes {
  /** Shot 1, 3 s: the name (≤ 20) and a one-line positioning (≤ 24). */
  opening: { name: string; position: string };
  /** Shot 2, 4 s: up to four knowledge titles (≤ 20 each); more sources show as "等 N 项". */
  sources: { titles: string[] };
  /** Shot 3, 5 s: one real question (≤ 30) and the first sentence of its answer (≤ 50). */
  answer: { question: string; answer: string };
  /** Shot 4, 3 s: a call to action (≤ 16) beside the price and the link. */
  closing: { cta: string };
}

export type VideoStyle = {
  template: VideoTemplate;
  accent: string;
  aspect: VideoAspect;
  music: boolean;
};

/** The Ree's live facts the video shows next to the script: they change the picture without a new script. */
export interface IntroRee {
  avatarUrl: string | null;
  color: string;
  /** Credits per answer for other people: base fee + the owner's query fee. */
  price: number;
  slug: string;
  /** The public page, for the closing QR code; null while the Ree is private. */
  shareUrl: string | null;
  /** Ready sources, for "等 N 项" when there are more than the titles shown. */
  sourcesTotal: number;
}

/** Everything the composition draws: Player and web renderer get exactly this (a `type`, as Remotion props must be). */
export type IntroProps = VideoStyle & {
  scenes: VideoScenes;
  ree: IntroRee;
};

export type SceneField = 'name' | 'position' | 'sources' | 'source' | 'question' | 'answer' | 'cta';

export interface SceneError {
  field: SceneField;
  /** Which source title, for `source`. */
  index?: number;
  issue: 'empty' | 'too_long' | 'too_many';
  max: number;
}

/** Characters as people count them: code points, so a Chinese character or an emoji is one. */
export function chars(text: string): number {
  return Array.from(text).length;
}

const SCENE_FIELDS: { field: Exclude<SceneField, 'sources' | 'source'>; read: (scenes: VideoScenes) => string; max: number }[] = [
  { field: 'name', read: (scenes) => scenes.opening.name, max: VIDEO_LIMITS.name },
  { field: 'position', read: (scenes) => scenes.opening.position, max: VIDEO_LIMITS.position },
  { field: 'question', read: (scenes) => scenes.answer.question, max: VIDEO_LIMITS.question },
  { field: 'answer', read: (scenes) => scenes.answer.answer, max: VIDEO_LIMITS.answer },
  { field: 'cta', read: (scenes) => scenes.closing.cta, max: VIDEO_LIMITS.cta },
];

/** Every limit the four shots break; empty when the script can be saved. */
export function sceneErrors(scenes: VideoScenes): SceneError[] {
  const errors: SceneError[] = [];
  for (const { field, read, max } of SCENE_FIELDS) {
    const value = read(scenes).trim();
    if (!value) errors.push({ field, issue: 'empty', max });
    else if (chars(value) > max) errors.push({ field, issue: 'too_long', max });
  }
  const titles = scenes.sources.titles;
  if (titles.length === 0) errors.push({ field: 'sources', issue: 'empty', max: VIDEO_LIMITS.sources });
  if (titles.length > VIDEO_LIMITS.sources) errors.push({ field: 'sources', issue: 'too_many', max: VIDEO_LIMITS.sources });
  titles.forEach((title, index) => {
    if (!title.trim()) errors.push({ field: 'source', index, issue: 'empty', max: VIDEO_LIMITS.source });
    else if (chars(title.trim()) > VIDEO_LIMITS.source) errors.push({ field: 'source', index, issue: 'too_long', max: VIDEO_LIMITS.source });
  });
  return errors;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** The four shots out of a request or a model reply, whitespace tidied; shape only, limits are `sceneErrors`. */
export function readScenes(input: unknown): VideoScenes | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, Record<string, unknown> | undefined>;
  const titles = value.sources?.titles;
  if (!Array.isArray(titles)) return null;
  return {
    opening: { name: text(value.opening?.name), position: text(value.opening?.position) },
    sources: { titles: titles.map(text).filter(Boolean) },
    answer: { question: text(value.answer?.question), answer: text(value.answer?.answer) },
    closing: { cta: text(value.closing?.cta) },
  };
}

export function isAccent(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export type VideoPatch = Partial<VideoStyle> & { scenes?: VideoScenes };

/**
 * `PATCH /api/rees/[id]/video`: any of the style fields and the scenes, and
 * the revision the editor loaded. Over-limit text is refused, never cut.
 */
export function parseVideoPatch(input: Record<string, unknown>): { patch: VideoPatch; revision: number } | { error: string; errors?: SceneError[] } {
  const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision < 0) return { error: 'invalid_revision' };
  const patch: VideoPatch = {};
  if (input.template !== undefined) {
    if (!VIDEO_TEMPLATES.includes(input.template as VideoTemplate)) return { error: 'invalid_template' };
    patch.template = input.template as VideoTemplate;
  }
  if (input.accent !== undefined) {
    if (!isAccent(input.accent)) return { error: 'invalid_accent' };
    patch.accent = input.accent.toLowerCase();
  }
  if (input.aspect !== undefined) {
    if (!VIDEO_ASPECTS.includes(input.aspect as VideoAspect)) return { error: 'invalid_aspect' };
    patch.aspect = input.aspect as VideoAspect;
  }
  if (input.music !== undefined) {
    if (typeof input.music !== 'boolean') return { error: 'invalid_music' };
    patch.music = input.music;
  }
  if (input.scenes !== undefined) {
    const scenes = readScenes(input.scenes);
    if (!scenes) return { error: 'invalid_scenes' };
    const errors = sceneErrors(scenes);
    if (errors.length) return { error: 'scene_limits', errors };
    patch.scenes = scenes;
  }
  return { patch, revision };
}

export const DEFAULT_STYLE: VideoStyle = { template: 'editorial', accent: VIDEO_DEFAULT_ACCENT, aspect: '16:9', music: true };

/* ------------------------------------------------------------- timeline */

export interface ShotWindow {
  /** First frame of the shot, at its cut. */
  start: number;
  /** One past its last frame. */
  end: number;
}

/** The four shots on the 360-frame timeline: 0–72, 72–168, 168–288, 288–360 at 24 fps. */
export function shotWindows(fps = VIDEO_FPS): ShotWindow[] {
  const windows: ShotWindow[] = [];
  let at = 0;
  for (const seconds of VIDEO_SHOT_SECONDS) {
    windows.push({ start: at, end: at + seconds * fps });
    at += seconds * fps;
  }
  return windows;
}

/** The shot a frame belongs to (cut to cut; the crossfade straddles each cut). */
export function shotAt(frame: number, fps = VIDEO_FPS): number {
  const index = shotWindows(fps).findIndex((window) => frame < window.end);
  return index === -1 ? VIDEO_SHOT_SECONDS.length - 1 : index;
}

/** 1280×720 or 720×1280. */
export function introSize(aspect: VideoAspect): { width: number; height: number } {
  return aspect === '9:16' ? { width: VIDEO_SHORT_SIDE, height: VIDEO_LONG_SIDE } : { width: VIDEO_LONG_SIDE, height: VIDEO_SHORT_SIDE };
}

export function clock(frame: number, fps = VIDEO_FPS): string {
  const seconds = Math.min(Math.floor(frame / fps), Math.floor(VIDEO_FRAMES / fps));
  return `00:${String(seconds).padStart(2, '0')}`;
}

/* ------------------------------------------------------------- money */

/** Each Ree's first export is free (`exports_count` 0); every later one costs 50. */
export function exportCost(exportsCount: number): number {
  return exportsCount === 0 ? 0 : VIDEO_EXPORT_CREDITS;
}

/* ------------------------------------------------------------- script text */

/** Chinese when the script has CJK characters: the video's own captions ("我知道的，从这里来。") follow it. */
export function scriptLang(scenes: VideoScenes): 'zh' | 'en' {
  const all = [scenes.opening.name, scenes.opening.position, scenes.answer.question, scenes.answer.answer, scenes.closing.cta, ...scenes.sources.titles].join('');
  return /[㐀-鿿豈-﫿]/.test(all) ? 'zh' : 'en';
}

/**
 * An answer's first sentence (2.6 "答案取第一句"), citation markers and
 * Markdown taken off: headings, quotes and list bullets at a line's start,
 * bold, emphasis and code around words. A `*` or `_` inside a word or a
 * sum (snake_case, 2*3) is text and stays.
 */
export function firstSentence(answer: string): string {
  const plain = answer
    .replace(/\s*\[\d+\]/g, '')
    .replace(/^[ \t]*(?:#{1,6}|>+|[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const match = /^.+?(?:[。！？!?]|\.(?=\s|$))/u.exec(plain);
  return (match ? match[0] : plain).trim();
}

/** The fields a model reply still has over their limits (empty and too-long both count), for the rewrite request. */
export function fieldsToRewrite(scenes: VideoScenes): SceneError[] {
  return sceneErrors(scenes).filter((error) => error.issue !== 'too_many');
}

/** JSON keys sorted, so the same props always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** "下载脚本" (prototype `download-script`): the script, its style and the fixed spec. */
export function scriptDownload(name: string, props: IntroProps): Record<string, unknown> {
  const windows = shotWindows();
  const durations = VIDEO_SHOT_SECONDS;
  return {
    ree: name,
    duration: VIDEO_FRAMES / VIDEO_FPS,
    fps: VIDEO_FPS,
    resolution: '720p',
    aspect: props.aspect,
    template: props.template,
    accent: props.accent,
    music: props.music,
    scenes: [
      { shot: 'opening', start: windows[0]!.start / VIDEO_FPS, duration: durations[0], ...props.scenes.opening },
      { shot: 'sources', start: windows[1]!.start / VIDEO_FPS, duration: durations[1], ...props.scenes.sources },
      { shot: 'answer', start: windows[2]!.start / VIDEO_FPS, duration: durations[2], ...props.scenes.answer },
      { shot: 'closing', start: windows[3]!.start / VIDEO_FPS, duration: durations[3], ...props.scenes.closing },
    ],
  };
}

/* ------------------------------------------------------------- browsers */

/**
 * Browsers the export refuses before probing (8.4 acceptance: Safari gets
 * "请用桌面 Chrome 或 Edge"): Safari and every iOS browser (all WebKit), and
 * phones and tablets. Others still go through `canRenderMediaOnWeb()`.
 */
export function exportBrowserRefused(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod|android|mobile/.test(ua)) return true;
  const chromium = /chrome|chromium|crios|edg\//.test(ua);
  const firefox = /firefox|fxios/.test(ua);
  return /safari/.test(ua) && !chromium && !firefox;
}
