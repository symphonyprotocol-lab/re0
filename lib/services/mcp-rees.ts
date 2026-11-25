/**
 * The MCP tools for Rees beyond lookup and Q&A: an owner's work on their own
 * Rees (create, settings, publish, delete, knowledge, statistics, the share
 * page) and what any signed-in user does to someone else's (comment,
 * favorite) -- each through the service function behind the web route for
 * the same action, for the account behind the key.
 *
 * A Ree is created from the same three steps the wizard validates
 * (`createRee`), without touching the draft the owner may have open on the
 * web. Knowledge is a URL (page, website, GitHub repository) or pasted text;
 * uploads (documents, audio) go through the browser's direct upload to
 * Blob, which MCP has no way to do. Processing knowledge spends the owner's
 * credits at what it actually costs, as on the web.
 */
import { randomUUID } from 'node:crypto';
import { MCP_REE_CREATE_PER_DAY } from '@/lib/constants';
import { InsufficientCredits } from '@/lib/domain/credits';
import { holdFor } from '@/lib/domain/knowledge';
import { isUuid } from '@/lib/domain/list';
import { reeCommentContent } from '@/lib/domain/ree-comment';
import { isShareStyle } from '@/lib/domain/share-style';
import { knowledgeQuery } from '@/lib/http/knowledge';
import { appBaseUrl } from '@/lib/http/cookies';
import type { ApiKeyCaller } from '@/lib/services/api-keys';
import { addKnowledge, KnowledgeInputError, listKnowledge, processKnowledge, recoverStale, type NewKnowledge } from '@/lib/services/knowledge';
import { runBatch } from '@/lib/services/knowledge-library';
import { checkMaxCost, insufficientCredits, invalidInput, McpToolError, ownReeOf, publicUrl, quietly, requireWrite, routeLimit, usableRee, type Defer } from '@/lib/services/mcp';
import { hitRateBucket } from '@/lib/services/rate-limit';
import { closeUnavailableRequests } from '@/lib/services/posts';
import { refreshProfile } from '@/lib/services/profile';
import { addReeComment, deleteReeComment, listReeComments } from '@/lib/services/ree-comments';
import { listFavoriteRees, setReeFavorite } from '@/lib/services/ree-favorites';
import { validateReeFields } from '@/lib/domain/ree';
import { createRee, deleteRee, ReeInputError, ReePublicationError, setReePublished, updateRee, type Ree } from '@/lib/services/rees';
import { shareStatistics } from '@/lib/services/share';
import { reeStatistics, statisticsQuery } from '@/lib/services/statistics';

const manageUrl = (id: string) => `${appBaseUrl()}/rees/${id}`;

function reeOut(ree: Ree) {
  return {
    id: ree.id,
    slug: ree.slug,
    name: ree.name,
    intro: ree.description,
    category: ree.category,
    tags: ree.tags,
    sample_questions: ree.sampleQuestions,
    system_prompt: ree.systemPrompt,
    query_fee: ree.queryFee,
    color: ree.color,
    is_public: ree.isPublic,
    is_published: ree.isPublished,
    taken_down: Boolean(ree.moderatedAt),
    public_qa_enabled: ree.publicQaEnabled,
    answers_posts: ree.answersPosts,
    share_style: ree.shareStyle,
    url: publicUrl(ree),
    manage_url: manageUrl(ree.id),
  };
}

/** The wizard's and the settings form's refusals, by field (lib/domain/ree.ts `validateReeFields`). */
const FIELD_MESSAGES: Record<string, string> = {
  name: 'name is required, at most 40 characters.',
  description: 'intro is at most 240 characters.',
  category: 'category must be one of: technology, design, business, learning, professional, life, travel, literature, other.',
  length: 'Each tag is at most 20 characters.',
  limit: 'At most 3 tags.',
  prompt: 'system_prompt is at most 4000 characters.',
  samples: 'At most 3 sample questions, each at most 160 characters.',
  fee: 'query_fee is a whole number of credits from 0 to 10000.',
  invalid_cover: 'The cover cannot be changed through MCP.',
};

function reeInputError(error: unknown): never {
  if (error instanceof ReeInputError) throw invalidInput(error.field, FIELD_MESSAGES[error.field] ?? `Invalid ${error.field}.`, { field: error.field });
  throw error;
}

export interface ReeFieldsInput {
  name?: string;
  intro?: string;
  category?: string;
  tags?: string[];
  system_prompt?: string;
  sample_questions?: string[];
  query_fee?: number;
  is_public?: boolean;
  color?: string;
}

/**
 * A new Ree, private and unpublished unless `is_public` (then `publish_ree`
 * shows it), from the same fields the wizard asks for; at most
 * `MCP_REE_CREATE_PER_DAY` a day per account, counted only once the fields
 * pass.
 */
export async function createReeTool(caller: ApiKeyCaller, input: ReeFieldsInput) {
  requireWrite(caller);
  const fields = {
    name: input.name ?? '',
    description: input.intro ?? '',
    category: input.category,
    tags: input.tags ?? [],
    systemPrompt: input.system_prompt ?? '',
    sampleQuestions: input.sample_questions ?? [],
    queryFee: input.query_fee ?? 0,
  };
  const invalid = validateReeFields(fields, 3);
  if (invalid) reeInputError(new ReeInputError(invalid.error, invalid.step));
  if (!(await hitRateBucket(`mcp:ree-create:${caller.user.id}`, MCP_REE_CREATE_PER_DAY, 86_400))) {
    throw new McpToolError('limit_reached', `At most ${MCP_REE_CREATE_PER_DAY} Rees a day can be created through MCP. Try again tomorrow, or create it on the web.`, { reason: 'ree_daily_limit' });
  }
  try {
    const { ree } = await createRee(caller.user.id, { ...fields, isPublic: input.is_public === true, color: input.color });
    return { ...reeOut(ree), next: 'Add knowledge with add_knowledge; once a source is ready the Ree can answer. A public Ree is shown to others after publish_ree.' };
  } catch (error) {
    reeInputError(error);
  }
}

export interface UpdateReeInput extends ReeFieldsInput {
  ree: string;
  public_qa_enabled?: boolean;
  answers_posts?: boolean;
  share_style?: string;
}

/**
 * The settings form (PATCH `/api/rees/[id]`) for the fields given, the
 * others as they are: validated as one form, a Ree made private leaves
 * discovery, and what the web does after it -- the public profile rebuilt,
 * requests a paid Ree can no longer take closed -- follows here too.
 */
export async function updateReeTool(caller: ApiKeyCaller, input: UpdateReeInput, defer: Defer) {
  requireWrite(caller);
  const current = await ownReeOf(caller.user.id, input.ree);
  if (input.share_style !== undefined && !isShareStyle(input.share_style)) throw invalidInput('share_style', 'share_style is "default" or "product".');
  let ree: Ree | null;
  try {
    ree = await updateRee(caller.user.id, current.id, {
      name: input.name ?? current.name,
      description: input.intro ?? current.description,
      category: input.category ?? current.category,
      tags: input.tags ?? current.tags,
      systemPrompt: input.system_prompt ?? current.systemPrompt,
      sampleQuestions: input.sample_questions ?? current.sampleQuestions,
      queryFee: input.query_fee ?? current.queryFee,
      isPublic: input.is_public ?? current.isPublic,
      color: input.color ?? current.color,
      avatarBlob: current.avatarBlob,
      publicQaEnabled: input.public_qa_enabled,
      answersPosts: input.answers_posts,
      shareStyle: isShareStyle(input.share_style) ? input.share_style : undefined,
    });
  } catch (error) {
    reeInputError(error);
  }
  if (!ree) throw new McpToolError('not_found', `No Ree "${input.ree}" of yours.`);
  const updated = ree;
  if (updated.isPublished) defer(quietly(`profile ${updated.id}`, () => refreshProfile(updated.id)));
  defer(quietly(`requests ${updated.id}`, () => closeUnavailableRequests(updated.id)));
  return reeOut(updated);
}

/** Shows a public Ree to everyone (published) or hides it again, keeping it public; a private or taken-down Ree cannot be published. */
export async function publishReeTool(caller: ApiKeyCaller, input: { ree: string; published?: boolean }, defer: Defer) {
  requireWrite(caller);
  const current = await ownReeOf(caller.user.id, input.ree);
  const published = input.published !== false;
  try {
    const ree = await setReePublished(caller.user.id, current.id, published);
    if (!ree) throw new McpToolError('not_found', `No Ree "${input.ree}" of yours.`);
    if (ree.isPublished) defer(quietly(`profile ${ree.id}`, () => refreshProfile(ree.id)));
    return reeOut(ree);
  } catch (error) {
    if (error instanceof ReePublicationError) {
      throw invalidInput(error.code, error.code === 'moderated' ? 'This Ree was taken down by re0 and cannot be published until it is restored.' : 'Only a public Ree can be published: set is_public with update_ree first.');
    }
    throw error;
  }
}

/** Deletes one of the caller's Rees: gone from re0, its past answers keep its name; requests waiting on it are closed. */
export async function deleteReeTool(caller: ApiKeyCaller, input: { ree: string }, defer: Defer) {
  requireWrite(caller);
  const current = await ownReeOf(caller.user.id, input.ree);
  if (!(await deleteRee(caller.user.id, current.id))) throw new McpToolError('not_found', `No Ree "${input.ree}" of yours.`);
  defer(quietly(`requests ${current.id}`, () => closeUnavailableRequests(current.id)));
  return { deleted: true, id: current.id, name: current.name };
}

/* -------------------------------------------------------------- knowledge */

export interface ListKnowledgeInput {
  ree: string;
  status?: string;
  kind?: string;
  query?: string;
  page?: number;
  trash?: boolean;
}

/**
 * The knowledge library of one of the caller's Rees, a page at a time, with
 * the counts per state. Like the library page, reading it first recovers
 * runs that died (resumed, or failed and refunded) and starts sources whose
 * run never began.
 */
export async function listKnowledgeTool(caller: ApiKeyCaller, input: ListKnowledgeInput, defer: Defer) {
  const ree = await ownReeOf(caller.user.id, input.ree);
  for (const id of await recoverStale(ree.id)) defer(quietly(`knowledge ${id}`, () => processKnowledge(id)));
  const query = knowledgeQuery({ q: input.query, status: input.status, kind: input.kind, page: input.page ? String(input.page) : undefined, size: '50', view: input.trash ? 'trash' : undefined });
  const result = await listKnowledge(ree.id, query);
  return {
    ree: { id: ree.id, name: ree.name },
    counts: result.counts,
    page: result.page,
    total: result.total,
    size: result.size,
    sources: result.items.map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      status: item.status,
      enabled: item.enabled,
      error: item.error,
      source: item.source,
      file_name: item.fileName,
      chars: item.chars,
      passages: item.chunks,
      ...(item.kind === 'file' ? { workspace_path: item.workspacePath, awaiting_confirmation: item.awaitingConfirmation } : {}),
      in_trash: Boolean(item.deletedAt),
      updated_at: item.updatedAt.toISOString(),
    })),
  };
}

const KNOWLEDGE_MESSAGES: Partial<Record<string, string>> = {
  invalid_text: 'Text needs a title and content within the limits.',
  invalid_url: 'url must be a public http(s) address.',
  invalid_github_url: 'url must be a GitHub repository address.',
  github_not_connected: 'Connect GitHub in re0 settings to add a private repository.',
  github_repo_not_found: 'That GitHub repository was not found (or is private and not connected).',
  github_ref_not_found: 'That branch or tag was not found.',
  domain_unverified: 'A whole website can only be added for a domain you verified in re0 settings.',
  source_unreachable: 'The address could not be reached.',
  busy: 'This source is being processed; try again once it finishes.',
  not_found: 'No such source in this Ree.',
};

function knowledgeRefusal(error: unknown): never {
  if (error instanceof KnowledgeInputError) {
    if (error.code === 'not_found') throw new McpToolError('not_found', KNOWLEDGE_MESSAGES.not_found!);
    throw invalidInput(error.code, KNOWLEDGE_MESSAGES[error.code] ?? `re0 refused this source: ${error.code}.`);
  }
  if (error instanceof InsufficientCredits) throw insufficientCredits(error.available, error.needed);
  throw error;
}

export interface AddKnowledgeInput {
  ree: string;
  kind: 'text' | 'page' | 'site' | 'github';
  title?: string;
  content?: string;
  url?: string;
  max_cost?: number;
}

/**
 * A source for one of the caller's Rees: pasted text, a web page, a whole
 * website (a verified domain) or a GitHub repository. Credits are held when
 * it is added and it is processed after the call; `list_knowledge` shows
 * when it is ready.
 */
export async function addKnowledgeTool(caller: ApiKeyCaller, input: AddKnowledgeInput, defer: Defer) {
  requireWrite(caller);
  const ree = await ownReeOf(caller.user.id, input.ree);
  const source: NewKnowledge =
    input.kind === 'text' ? { kind: 'text', title: input.title ?? '', content: input.content ?? '' } : { kind: input.kind, url: input.url ?? '' };
  /* What is reserved when it is added; processing then stops before it would pass `max_cost` (knowledge.ts `CostCapReached`). */
  checkMaxCost(input.max_cost, holdFor(input.kind, input.content), 'Adding this source');
  let id: string;
  try {
    id = await addKnowledge(caller.user.id, ree, source, input.max_cost === undefined ? {} : { maxCredits: input.max_cost });
  } catch (error) {
    knowledgeRefusal(error);
  }
  defer(quietly(`knowledge ${id}`, () => processKnowledge(id)));
  return { id, ree: { id: ree.id, name: ree.name }, status: 'pending', next: 'Processing has started. Call list_knowledge to see when it is ready (or why it failed).' };
}

/** Moves a source to the trash (purged with its passages after 30 days); one still being processed must finish first. */
export async function deleteKnowledgeTool(caller: ApiKeyCaller, input: { ree: string; knowledge: string }, defer: Defer) {
  requireWrite(caller);
  const ree = await ownReeOf(caller.user.id, input.ree);
  if (!isUuid(input.knowledge)) throw new McpToolError('not_found', KNOWLEDGE_MESSAGES.not_found!);
  try {
    await runBatch(caller.user.id, ree.id, { action: 'trash', ids: [input.knowledge] });
  } catch (error) {
    knowledgeRefusal(error);
  }
  if (ree.isPublished) defer(quietly(`profile ${ree.id}`, () => refreshProfile(ree.id)));
  return { trashed: true, id: input.knowledge, ree: { id: ree.id, name: ree.name } };
}

/* ---------------------------------------------------- comments, favorites */

async function reeIdOf(userId: string, ref: string): Promise<string> {
  const ree = await usableRee(userId, ref);
  if (!ree) throw new McpToolError('not_found', `No Ree "${ref}" that you can see.`);
  return ree.id;
}

/** The comments under a public Ree, newest first, 20 at a time (`before`: the last one's id). */
export async function listReeCommentsTool(caller: ApiKeyCaller, input: { ree: string; before?: string }) {
  if (input.before !== undefined && !isUuid(input.before)) throw invalidInput('invalid_cursor', 'before is the id of a comment from an earlier page.');
  const id = await reeIdOf(caller.user.id, input.ree);
  const page = await listReeComments(id, input.before, caller.user.id);
  if (!page) throw new McpToolError('not_found', 'Only a public Ree has comments.');
  return {
    ree: id,
    total: page.total,
    next_before: page.next,
    comments: page.items.map((comment) => ({ id: comment.id, author: comment.authorName, content: comment.content, created_at: comment.createdAt, can_delete: comment.canDelete })),
  };
}

/** A comment under a public Ree, limited as the web limits comments. */
export async function addReeCommentTool(caller: ApiKeyCaller, input: { ree: string; content: string; client_token?: string }) {
  requireWrite(caller);
  const id = await reeIdOf(caller.user.id, input.ree);
  const content = reeCommentContent(input.content);
  if (content === null) throw invalidInput('invalid_comment', 'A comment is 1–500 characters.');
  await routeLimit('comment', caller);
  const saved = await addReeComment(id, caller.user, { id: input.client_token && isUuid(input.client_token) ? input.client_token : randomUUID(), content });
  if (!saved) throw new McpToolError('not_found', 'Only a public Ree takes comments.');
  if (saved === 'conflict') throw new McpToolError('conflict', 'client_token was already used for a different comment.');
  return { id: saved.id, ree: id, content: saved.content, created_at: saved.createdAt };
}

/** Its author, or the Ree's owner, removes a comment. */
export async function deleteReeCommentTool(caller: ApiKeyCaller, input: { ree: string; comment: string }) {
  requireWrite(caller);
  if (!isUuid(input.ree) || !isUuid(input.comment)) throw new McpToolError('not_found', 'Pass the Ree’s id and the comment’s id.');
  if (!(await deleteReeComment(input.ree, input.comment, caller.user.id))) throw new McpToolError('not_found', 'No such comment that you may delete.');
  return { deleted: true, comment: input.comment };
}

/** Saves someone else's public Ree to the caller's favorites, or removes it. */
export async function favoriteReeTool(caller: ApiKeyCaller, input: { ree: string; favorite?: boolean }) {
  requireWrite(caller);
  const favorite = input.favorite !== false;
  /* Removing works by id even once the Ree is no longer public, as on the web. */
  const id = !favorite && isUuid(input.ree) ? input.ree : await reeIdOf(caller.user.id, input.ree);
  if (!(await setReeFavorite(caller.user.id, id, favorite))) throw new McpToolError('not_found', 'Only someone else’s public Ree can be a favorite.');
  return { ree: id, favorite };
}

/** The caller's favorite Rees, a page at a time. */
export async function listFavoriteReesTool(caller: ApiKeyCaller, input: { page?: number }) {
  const result = await listFavoriteRees(caller.user.id, Math.max(1, Math.floor(input.page ?? 1)));
  return {
    page: result.page,
    total: result.total,
    rees: result.items.map((ree) => ({ id: ree.id, slug: ree.slug, name: ree.name, intro: ree.description, owner: { name: ree.ownerName }, url: `${appBaseUrl()}/r/${ree.slug}` })),
  };
}

/* --------------------------------------------------- share and statistics */

/**
 * The share page (`/s/<slug>`) of a Ree: its link when the Ree has one
 * (public, published, not taken down); for the caller's own Ree also what
 * the share page brought in, all time.
 */
export async function shareLinkTool(caller: ApiKeyCaller, input: { ree: string }) {
  const ree = await usableRee(caller.user.id, input.ree);
  if (!ree) throw new McpToolError('not_found', `No Ree "${input.ree}" that you can see.`);
  const url = publicUrl(ree);
  const own = ree.ownerId === caller.user.id;
  const stats = own ? await shareStatistics(ree.id, null) : null;
  return {
    ree: { id: ree.id, slug: ree.slug, name: ree.name },
    shareable: Boolean(url),
    share_url: url ? `${appBaseUrl()}/s/${ree.slug}` : null,
    public_url: url,
    ...(url ? {} : { why_not: own ? 'Only a public, published Ree has a share page: update_ree with is_public, then publish_ree.' : 'This Ree is not public.' }),
    ...(stats
      ? { statistics: { visits: stats.visits, visitors: stats.visitors, conversions: stats.conversations, converted_visitors: stats.converted, conversion_rate_percent: stats.rate, anonymous_answers: stats.anonymousAnswers } }
      : {}),
  };
}

export interface StatisticsInput {
  ree: string;
  period?: string;
  date?: string;
  start?: string;
  end?: string;
  page?: number;
}

/** One of the caller's Rees' usage in a period, as its statistics page shows it (an official account's income stays in the console). */
export async function reeStatisticsTool(caller: ApiKeyCaller, input: StatisticsInput) {
  const ree = await ownReeOf(caller.user.id, input.ree);
  const withIncome = caller.user.role !== 'official';
  const query = statisticsQuery({ period: input.period ?? 'all', date: input.date ?? '', start: input.start ?? '', end: input.end ?? '', view: 'answers', page: String(input.page ?? 1) });
  const stats = await reeStatistics(ree.id, query, { withIncome });
  return {
    ree: { id: ree.id, name: ree.name },
    period: stats.filter,
    answers: stats.answers,
    saved: stats.saved,
    sources: stats.sources,
    income: withIncome ? stats.income : null,
    trend: stats.trend,
    recent_answers: stats.answerList,
    share: stats.share,
    answer_checks: stats.checks,
  };
}
