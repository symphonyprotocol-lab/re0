/**
 * A Ree's fields and the setup draft, as the prototype defines them
 * (dot-setup.js, dot-classification.js; rebuild-proposal.md 8.2 "Ree 字段").
 * Shared by the wizard, the settings page and the API, which re-validates
 * everything the browser already checked.
 */
import {
  QUERY_FEE,
  REE_CATEGORIES,
  REE_COLORS,
  REE_LIMITS,
  type ReeCategory,
  type ReeColor,
} from '@/lib/constants';
import { isUuid } from '@/lib/domain/list';

const LOWER_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const AVATAR_PATH = new RegExp(`^avatars/(${LOWER_UUID})/${LOWER_UUID}\\.(?:jpg|png|webp)$`);

/**
 * Exactly what `/api/upload-token` writes for an avatar:
 * `avatars/<user id>/<random id>.<jpg|png|webp>`, optionally under one owner.
 */
export function isAvatarPath(pathname: unknown, ownerId?: string): pathname is string {
  if (typeof pathname !== 'string') return false;
  const match = AVATAR_PATH.exec(pathname);
  return Boolean(match) && (ownerId === undefined || match![1] === ownerId.toLowerCase());
}

/**
 * Where a stored avatar is shown: an uploaded one through /media, only in the
 * exact shape the uploader writes (a stored `avatars/x/../../api/…` would
 * otherwise make every viewer GET a same-origin path); anything else is an
 * external URL (OAuth).
 */
export function avatarImageUrl(avatar: string | null | undefined): string | null {
  if (!avatar) return null;
  if (avatar.startsWith('avatars/')) return isAvatarPath(avatar) ? `/media/${avatar}` : null;
  return avatar;
}

export function isReeCoverPath(pathname: string, reeId: string): boolean {
  const [directory, id, file, ...rest] = pathname.split('/');
  const [key, extension, ...suffix] = (file ?? '').split('.');
  return directory === 'ree-covers' && id === reeId && isUuid(id) && !rest.length &&
    isUuid(key) && !suffix.length && (extension === 'jpg' || extension === 'png' || extension === 'webp');
}

/** Suggested tags per category; anything else may be typed (prototype dot-classification.js). */
export const CATEGORY_TAGS: Record<ReeCategory, { zh: string[]; en: string[] }> = {
  technology: {
    zh: ['技术开发', 'AI 应用', 'React', 'Next.js', 'Python', '数据分析', '开源项目', '自动化'],
    en: ['Software', 'AI apps', 'React', 'Next.js', 'Python', 'Data analysis', 'Open source', 'Automation'],
  },
  design: {
    zh: ['产品设计', '用户体验', '设计系统', '视觉设计', '品牌设计', '内容创作', '摄影', '视频制作'],
    en: ['Product design', 'UX', 'Design systems', 'Visual design', 'Branding', 'Content', 'Photography', 'Video'],
  },
  business: {
    zh: ['商业增长', '市场营销', '产品管理', '独立开发', '创业', '团队管理', '职场技能', '销售'],
    en: ['Growth', 'Marketing', 'Product management', 'Indie hacking', 'Startups', 'Management', 'Career', 'Sales'],
  },
  learning: {
    zh: ['阅读写作', '学习方法', '语言学习', '科学研究', '历史', '教育', '读书笔记', '知识管理'],
    en: ['Reading & writing', 'Study skills', 'Languages', 'Research', 'History', 'Education', 'Book notes', 'PKM'],
  },
  professional: {
    zh: ['金融财经', '法律合规', '医学健康', '工程制造', '建筑', '行业研究', '财务会计', '供应链'],
    en: ['Finance', 'Law', 'Health', 'Engineering', 'Architecture', 'Industry research', 'Accounting', 'Supply chain'],
  },
  life: {
    zh: ['生活方式', '旅行文化', '艺术鉴赏', '运动健身', '个人成长', '效率工具', '烹饪', '音乐'],
    en: ['Lifestyle', 'Travel', 'Arts', 'Fitness', 'Personal growth', 'Productivity', 'Cooking', 'Music'],
  },
  other: { zh: [], en: [] },
};

export function isCategory(value: unknown): value is ReeCategory {
  return typeof value === 'string' && (REE_CATEGORIES as readonly string[]).includes(value);
}

export function isColor(value: unknown): value is ReeColor {
  return typeof value === 'string' && (REE_COLORS as readonly string[]).includes(value);
}

export function charLength(value: string): number {
  return Array.from(value).length;
}

export function normalizedTag(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
}

export type ClassificationError = 'category' | 'length' | 'limit';

/** Category required, tags trimmed and de-duplicated case-insensitively, each ≤ 20, at most 3. */
export function classification(
  category: unknown,
  rawTags: readonly unknown[],
): { category: ReeCategory; tags: string[] } | { error: ClassificationError } {
  if (!isCategory(category)) return { error: 'category' };
  const tags: string[] = [];
  for (const raw of rawTags) {
    const tag = normalizedTag(raw);
    if (!tag) continue;
    if (charLength(tag) > REE_LIMITS.tag) return { error: 'length' };
    if (!tags.some((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase())) tags.push(tag);
  }
  if (tags.length > REE_LIMITS.tags) return { error: 'limit' };
  return { category, tags };
}

/** Sample questions arrive one per line from the form. */
export function sampleQuestionList(value: string | readonly string[]): string[] {
  const lines = typeof value === 'string' ? value.split('\n') : value;
  return lines.map((line) => line.trim()).filter(Boolean);
}

/** `user.ree_draft`: everything the three steps collect, saved on every step change. */
export interface ReeDraft {
  name: string;
  description: string;
  avatarBlob: string | null;
  color: ReeColor;
  category: ReeCategory | '';
  tags: string[];
  systemPrompt: string;
  /** One question per line, as typed. */
  sampleQuestions: string;
  isPublic: boolean;
  queryFee: number;
  /** The step being shown and the furthest one reached; later steps stay locked. */
  step: number;
  reached: number;
}

export function newReeDraft(): ReeDraft {
  return {
    name: '',
    description: '',
    avatarBlob: null,
    color: 'default',
    category: '',
    tags: [],
    systemPrompt: '',
    sampleQuestions: '',
    isPublic: false,
    queryFee: QUERY_FEE.default,
    step: 1,
    reached: 1,
  };
}

function clampStep(value: unknown): number {
  const step = Number(value);
  return Number.isInteger(step) ? Math.min(3, Math.max(1, step)) : 1;
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/**
 * Whatever the browser sent, coerced into a draft's shape. Length caps here
 * are generous storage bounds (twice each limit); the real limits are
 * `validateReeFields`, which reports them instead of silently trimming.
 */
export function coerceDraft(input: unknown): ReeDraft {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const base = newReeDraft();
  const reached = clampStep(raw.reached);
  return {
    name: str(raw.name, REE_LIMITS.name * 2),
    description: str(raw.description, REE_LIMITS.description * 2),
    avatarBlob: isAvatarPath(raw.avatarBlob) ? raw.avatarBlob : null,
    color: isColor(raw.color) ? raw.color : base.color,
    category: isCategory(raw.category) ? raw.category : '',
    tags: Array.isArray(raw.tags) ? raw.tags.map((tag) => str(tag, REE_LIMITS.tag * 2)).slice(0, 10) : [],
    systemPrompt: str(raw.systemPrompt, REE_LIMITS.systemPrompt * 2),
    sampleQuestions: str(raw.sampleQuestions, REE_LIMITS.sampleQuestion * 8),
    isPublic: raw.isPublic === true,
    queryFee: Number.isFinite(Number(raw.queryFee)) ? Number(raw.queryFee) : base.queryFee,
    step: Math.min(clampStep(raw.step), reached),
    reached,
  };
}

export type ReeFieldError =
  | 'name'
  | 'description'
  | ClassificationError
  | 'prompt'
  | 'samples'
  | 'fee';

export interface ReeFields {
  name: string;
  description: string;
  category: unknown;
  tags: readonly unknown[];
  systemPrompt: string;
  sampleQuestions: string | readonly string[];
  queryFee: unknown;
}

/**
 * The prototype's `validateDotDraft`: checks up to `step` and names the
 * first step that is wrong, so the wizard can send the user back there.
 */
export function validateReeFields(fields: ReeFields, step: number): { step: number; error: ReeFieldError } | null {
  const name = fields.name.trim();
  if (!name || charLength(name) > REE_LIMITS.name) return { step: 1, error: 'name' };
  if (charLength(fields.description) > REE_LIMITS.description) return { step: 1, error: 'description' };
  if (step < 2) return null;
  const classified = classification(fields.category, fields.tags);
  if ('error' in classified) return { step: 2, error: classified.error };
  if (charLength(fields.systemPrompt) > REE_LIMITS.systemPrompt) return { step: 2, error: 'prompt' };
  const samples = sampleQuestionList(fields.sampleQuestions);
  if (samples.length > REE_LIMITS.sampleQuestions || samples.some((s) => charLength(s) > REE_LIMITS.sampleQuestion)) {
    return { step: 2, error: 'samples' };
  }
  if (step >= 3) {
    const fee = Number(fields.queryFee);
    if (!Number.isInteger(fee) || fee < QUERY_FEE.min || fee > QUERY_FEE.max) return { step: 3, error: 'fee' };
  }
  return null;
}

/** The validated, trimmed values a Ree row is written from. */
export function reeValues(fields: ReeFields & { isPublic: boolean; color: unknown }) {
  const classified = classification(fields.category, fields.tags);
  if ('error' in classified) throw new Error(classified.error);
  return {
    name: fields.name.trim(),
    description: fields.description.trim(),
    color: isColor(fields.color) ? fields.color : 'default',
    category: classified.category,
    tags: classified.tags,
    systemPrompt: fields.systemPrompt.trim(),
    sampleQuestions: sampleQuestionList(fields.sampleQuestions),
    isPublic: fields.isPublic,
    queryFee: Number(fields.queryFee),
  };
}

/** `ree-` and eight base-36 characters; the unique index decides, a clash retries. */
export function randomSlug(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `ree-${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`;
}

/* ------------------------------------------------- batch visibility (/rees) */

/** The most Rees one batch visibility change takes, and the most "选中全部结果" selects. */
export const REE_BATCH_MAX = 5_000;

export interface VisibilityRow {
  id: string;
  isPublic: boolean;
  /** Taken down by an administrator: it cannot be made public until restored (2.5). */
  moderated: boolean;
}

export interface VisibilityPlan {
  changes: string[];
  unchanged: string[];
  blocked: string[];
  missing: string[];
}

/**
 * What "设为公开 / 设为私有" would do to a selection (prototype owned-rees.js
 * `ownedReeVisibilityPlan`): Rees already at the target stay as they are, a
 * taken-down Ree is skipped when going public, ids no longer the owner's
 * are reported missing. The browser shows it for review; the server runs it
 * again on the rows it locked.
 */
export function visibilityPlan(rows: readonly VisibilityRow[], ids: Iterable<string>, isPublic: boolean): VisibilityPlan {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const plan: VisibilityPlan = { changes: [], unchanged: [], blocked: [], missing: [] };
  for (const id of new Set(ids)) {
    const row = byId.get(id);
    if (!row) plan.missing.push(id);
    else if (isPublic && row.moderated) plan.blocked.push(id);
    else if (row.isPublic === isPublic) plan.unchanged.push(id);
    else plan.changes.push(id);
  }
  return plan;
}
