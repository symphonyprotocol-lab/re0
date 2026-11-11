/**
 * A Ree's 15-second narrated introduction without the database
 * (rebuild-proposal.md 2.6): the stored script, its style, what an export
 * costs, and the props the Remotion composition in `video/` draws. Shared by
 * the server (script generation, export cache identity), the editor and the
 * composition. The story itself, per video type, is in `product-demo.ts`.
 */
import {
  VIDEO_ASPECTS,
  VIDEO_DEFAULT_ACCENT,
  VIDEO_FPS,
  VIDEO_FRAMES,
  VIDEO_LONG_SIDE,
  VIDEO_SHORT_SIDE,
  VIDEO_TEMPLATES,
  type VideoAspect,
  type VideoTemplate,
} from '@/lib/constants';
import { PRODUCT_DEMO_TEMPLATE, type VideoStory } from '@/lib/domain/product-demo';

/**
 * The stored script. `demo` is the narrated story; the other fields are the
 * Ree's name and one-line positioning, its knowledge titles and a closing
 * line, which posters, cards and link previews show.
 */
export interface VideoScenes {
  demo?: VideoStory;
  opening: { name: string; position: string };
  sources: { titles: string[] };
  answer: { question: string; answer: string };
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
  narrationUrl?: string;
  scenes: VideoScenes;
  ree: IntroRee;
};

export function hasVideoAudio(props: IntroProps): boolean {
  return props.music || Boolean(props.narrationUrl);
}

/** Characters as people count them: code points, so a Chinese character or an emoji is one. */
export function chars(text: string): number {
  return Array.from(text).length;
}

export function isAccent(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export type VideoPatch = Partial<VideoStyle>;

/** `PATCH /api/rees/[id]/video`: any of the style fields, and the revision the editor loaded. */
export function parseVideoPatch(input: Record<string, unknown>): { patch: VideoPatch; revision: number } | { error: string } {
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
  return { patch, revision };
}

export const DEFAULT_STYLE: VideoStyle = { template: PRODUCT_DEMO_TEMPLATE, accent: VIDEO_DEFAULT_ACCENT, aspect: '16:9', music: true };

/* ------------------------------------------------------------- timeline */

/** 1280×720 or 720×1280. */
export function introSize(aspect: VideoAspect): { width: number; height: number } {
  return aspect === '9:16' ? { width: VIDEO_SHORT_SIDE, height: VIDEO_LONG_SIDE } : { width: VIDEO_LONG_SIDE, height: VIDEO_SHORT_SIDE };
}

export function clock(frame: number, fps = VIDEO_FPS): string {
  const seconds = Math.min(Math.floor(frame / fps), Math.floor(VIDEO_FRAMES / fps));
  return `00:${String(seconds).padStart(2, '0')}`;
}

/* ------------------------------------------------------------- money */

/** Each Ree's first completed export is free. */
export function exportCost(exportsCount: number, laterCredits: number): number {
  return exportsCount === 0 ? 0 : laterCredits;
}

/* ------------------------------------------------------------- script text */

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

/**
 * What an exported MP4 is drawn from, and nothing else (video/product-demo.tsx
 * `NarratedVideo`, video/intro.tsx `introComposition`): the frame size, the
 * story and its narration, the opening name, the accent and the music. The
 * Ree's price, source count, share link, avatar and slug ride along in
 * `IntroProps` for the cards but never reach a frame, so a change to them
 * must not make an export stale (review C4). A new field the composition
 * starts drawing belongs here, with `VIDEO_COMPOSITION_VERSION` bumped.
 */
export function renderInputs(props: IntroProps) {
  return {
    template: props.template,
    aspect: props.aspect,
    accent: props.accent,
    music: props.music,
    narrationUrl: props.narrationUrl ?? null,
    name: props.scenes.opening.name,
    story: props.scenes.demo ?? null,
  };
}

/** `renderInputs` as one comparable string: same string, same picture. */
export function renderKey(props: IntroProps): string {
  return canonicalJson(renderInputs(props));
}

/** "下载脚本" (prototype `download-script`): the script, its style and the fixed spec. */
export function scriptDownload(name: string, props: IntroProps): Record<string, unknown> {
  const spec = {
    ree: name,
    duration: VIDEO_FRAMES / VIDEO_FPS,
    fps: VIDEO_FPS,
    resolution: '720p',
    aspect: props.aspect,
    template: props.template,
    accent: props.accent,
    music: props.music,
  };
  if (!props.scenes.demo) return spec;
  const { audioId: _audioId, cues, kind: _kind, ...story } = props.scenes.demo;
  return {
    ...spec,
    voice: 'AI-generated English narration',
    ...story,
    captions: cues.map((cue) => ({ text: cue.text, start: cue.start / VIDEO_FPS, end: cue.end / VIDEO_FPS })),
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
