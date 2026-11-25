/**
 * The MCP tools for posts (帖子): read the feeds and one post, post publicly
 * or privately, follow up, and the author's and readers' actions -- each
 * through the service function behind the web route for the same action,
 * with that route's limit (`routeLimit`), for the account behind the key.
 *
 * Asking costs what it costs on the web: a public post or follow-up nothing
 * up front, each free Ree's answer the base fee (paid Rees wait for the
 * asker's `respond_paid_request`); a private one the base fee plus each
 * chosen Ree's query fee, held when it is sent. A `max_cost` below what the
 * action can cost is refused before anything is saved or held.
 *
 * The web answers after its response (`after`); so does this, through the
 * `Defer` the HTTP layer passes, and the posts cron picks up whatever that
 * misses. `get_post` reads the answers once they are written.
 */
import { QUERY_BASE_FEE } from '@/lib/constants';
import type { CitationSnapshot } from '@/lib/domain/answer';
import { FEED_TABS, POST_MAX_ANSWERS, POST_PAGE_SIZE, POST_TITLE_MAX, type FeedTab, type PostAnswerView, type PostAuthor, type PostView } from '@/lib/domain/post';
import { isUuid } from '@/lib/domain/list';
import { appBaseUrl } from '@/lib/http/cookies';
import type { ApiKeyCaller } from '@/lib/services/api-keys';
import { maxCostFor } from '@/lib/services/grounded-answer';
import { checkMaxCost, insufficientCredits, invalidInput, McpToolError, quietly, requireWrite, routeLimit, usableRee, type Defer } from '@/lib/services/mcp';
import { askFollowup, deleteFollowup, privateThreadRees, processFollowup } from '@/lib/services/post-followups';
import {
  agreePaidAnswer,
  answerPaid,
  declinePaidAnswer,
  getPost,
  listFeed,
  listMyPosts,
  listSavedPosts,
  postAllowance,
  processPost,
  publishPost,
  setAnswerHelpful,
  setPostHelpful,
  setPostSaved,
  setPostTrashed,
  type MinePostsView,
} from '@/lib/services/posts';
import { askPrivateFollowup, convertToPublic, isPrivatePost, processPrivateFollowup, processPrivatePost, publishPrivatePost, updatePrivatePost } from '@/lib/services/private-posts';

/* ------------------------------------------------------------------ views */

const postUrl = (id: string) => `${appBaseUrl()}/p/${id}`;

function authorOut(author: PostAuthor) {
  switch (author.kind) {
    case 'user':
      return { name: author.name, is_you: author.mine };
    case 'hidden':
      return { name: null, anonymous: true, is_you: author.mine };
    default:
      return { name: null, kind: author.kind, is_you: false };
  }
}

function citationOut(citation: CitationSnapshot) {
  return { index: citation.index, source: citation.title, kind: citation.kind, locator: citation.locator, excerpt: citation.excerpt };
}

function answerOut(view: PostAnswerView) {
  return {
    id: view.id,
    ree: { id: view.reeId, slug: view.reeSlug, name: view.reeName, official: view.official },
    state: view.state,
    text: view.text,
    truncated: view.truncated,
    citations: view.citations.map(citationOut),
    helpful: view.helpful,
    voted_helpful: view.voted,
    pinned: view.pinned,
    paid: view.paid,
    cost: view.cost,
  };
}

/** A post as the web shows it to this viewer; the thread, candidates and requests only on the post's own page (`whole`). */
export function postOut(view: PostView) {
  return {
    id: view.id,
    url: postUrl(view.id),
    visibility: view.visibility,
    title: view.title,
    question: view.question,
    detail: view.detail,
    lang: view.lang,
    category: view.category,
    author: authorOut(view.author),
    status: view.status,
    answer_state: view.answerState,
    hidden_by: view.hiddenBy,
    created_at: view.createdAt,
    channels: view.channels,
    images: view.images.length,
    pinned: view.pinned,
    archived: view.archived,
    deleted: view.deleted,
    saved: view.saved,
    helpful: view.helpful,
    voted_helpful: view.voted,
    published_copy_id: view.publishedCopyId,
    quote: view.quote?.available ? { kind: view.quote.kind, post_id: view.quote.postId, question: view.quote.question, answer: view.quote.answer ? { id: view.quote.answer.id, ree_name: view.quote.answer.reeName, text: view.quote.answer.text } : null } : view.quote ? { kind: view.quote.kind, available: false } : null,
    answered: view.answered,
    answers: view.answers.map(answerOut),
    ai_answer: view.aiAnswer ? { id: view.aiAnswer.id, state: view.aiAnswer.state, text: view.aiAnswer.text, truncated: view.aiAnswer.truncated, cost: view.aiAnswer.cost, note: 'A general AI answer, not from any Ree’s knowledge.' } : null,
    summary: view.summary ? { state: view.summary.state, content: view.summary.content } : null,
    followup_count: view.followupCount,
    followups: view.followups.map((followup) => ({
      id: followup.id,
      author: { name: followup.author.name, is_post_author: followup.author.poster, is_you: followup.author.mine },
      question: followup.question,
      mentions: followup.mentions.map((mention) => ({ ree_id: mention.reeId, ree_name: mention.reeName })),
      status: followup.status,
      answer_state: followup.answerState,
      created_at: followup.createdAt,
      answers: followup.answers.map(answerOut),
      ai_answer: followup.aiAnswer ? { id: followup.aiAnswer.id, state: followup.aiAnswer.state, text: followup.aiAnswer.text, cost: followup.aiAnswer.cost } : null,
      paid_requests: followup.paidRequests.map(requestOut),
      spent: followup.spent,
    })),
    followup_candidates: view.followupCandidates.map((candidate) => ({ ree_id: candidate.reeId, slug: candidate.reeSlug, name: candidate.reeName, price: candidate.price, paid: candidate.paid })),
    followup_blocked: view.followupBlocked,
    paid_requests: view.paidRequests.map(requestOut),
    spent: view.spent,
  };
}

function requestOut(request: PostView['paidRequests'][number]) {
  return { request_id: request.id, ree: { id: request.reeId, slug: request.reeSlug, name: request.reeName }, owner_name: request.ownerName, price: request.price, state: request.state, mentioned: request.mentioned };
}

/* ------------------------------------------------------------------ reads */

export const POST_FEEDS = [...FEED_TABS, 'mine', 'saved'] as const;
export type PostFeed = (typeof POST_FEEDS)[number];
export const MINE_VIEWS = ['all', 'public', 'private', 'trash'] as const;

export interface ListPostsInput {
  feed?: PostFeed;
  query?: string;
  channel?: string;
  cursor?: string;
  page?: number;
  view?: MinePostsView;
  archived?: boolean;
  pinned?: boolean;
}

/** The public feeds (`/api/posts`, limited as browsing is), or the caller's own posts (我的帖子) and saved posts, a page at a time. */
export async function listPostsTool(caller: ApiKeyCaller, input: ListPostsInput) {
  const feed: PostFeed = input.feed ?? 'latest';
  const userId = caller.user.id;
  if (feed === 'mine' || feed === 'saved') {
    const page = Math.max(1, Math.floor(input.page ?? 1));
    const result = feed === 'saved' ? await listSavedPosts(userId, page) : await listMyPosts(userId, input.view ?? 'all', page, POST_PAGE_SIZE, { q: input.query ?? null, archived: input.archived, pinned: input.pinned });
    return { feed, page: result.page, total: result.total, has_more: result.page * result.size < result.total, posts: result.items.map(postOut) };
  }
  await routeLimit('browse', caller);
  const result = await listFeed(feed as FeedTab, { cursor: input.cursor ?? null, q: input.query?.slice(0, 200) ?? null, channel: input.channel?.replace(/^#/, '').slice(0, 64) ?? null, viewerId: userId });
  return { feed, next_cursor: result.next, posts: result.items.map(postOut) };
}

function postNotFound(id: string): McpToolError {
  return new McpToolError('not_found', `No post "${id}" you can see: it does not exist, was taken down, or is someone else’s private post.`);
}

/** One post as its page shows it to the caller: answers, AI answer, follow-ups, and (theirs) what is waiting for them and what it cost. */
export async function getPostTool(caller: ApiKeyCaller, input: { post: string }) {
  const view = await getPost(input.post, caller.user.id);
  if (!view) throw postNotFound(input.post);
  return postOut(view);
}

/* ---------------------------------------------------------------- posting */

/** A Ree to ask or name, by id or slug: one the caller may ask (theirs, or public). */
async function reeIdFor(userId: string, ref: string) {
  const ree = await usableRee(userId, ref);
  if (!ree) throw new McpToolError('not_found', `No Ree "${ref}" that you can ask: it does not exist, is private to someone else, or was taken down.`);
  return ree;
}

const PUBLIC_POST_MAX_COST = POST_MAX_ANSWERS * QUERY_BASE_FEE;

export interface CreatePostInput {
  visibility: 'public' | 'private';
  question: string;
  detail?: string;
  anonymous?: boolean;
  mention_ree?: string;
  quote_post_id?: string;
  quote_answer_id?: string;
  rees?: string[];
  max_cost?: number;
  client_token?: string;
}

const POST_ERRORS: Record<string, string> = {
  empty: 'The question is empty.',
  too_long: 'The question is at most 300 characters and the detail at most 2000.',
  quote_unavailable: 'The post or answer to quote can no longer be seen.',
  no_rees: 'A private post needs at least one Ree in rees.',
  too_many_rees: 'A private post asks at most five Rees.',
  ree_unavailable: 'One of the Rees can no longer be asked.',
  mention_unavailable: 'Only Rees in this thread may be mentioned (on a public post: those that answered its first round).',
  no_candidates: 'No Ree can answer a follow-up here yet.',
};

function postRefusal(error: string): McpToolError {
  if (error === 'daily_limit' || error === 'post_daily_limit') return new McpToolError('limit_reached', 'You reached today’s limit for this on re0 (the same limit as on the web). Try again tomorrow.', { reason: error });
  if (error === 'full') return new McpToolError('limit_reached', 'This thread is full. Start a new post instead.', { reason: error });
  return invalidInput(error, POST_ERRORS[error] ?? `re0 refused this: ${error}.`);
}

/**
 * Posts publicly (发帖: reviewed, then free Rees matching it answer, each at
 * the base fee; paid ones wait for `respond_paid_request`) or privately
 * (私密提问: the chosen Rees, held at their price now, answer at once). Both
 * answer after the call returns; `get_post` reads them.
 */
export async function createPostTool(caller: ApiKeyCaller, input: CreatePostInput, defer: Defer) {
  requireWrite(caller);
  const userId = caller.user.id;
  const clientToken = input.client_token && isUuid(input.client_token) ? input.client_token : null;
  if (input.visibility === 'private') {
    await routeLimit('ask', caller);
    const refs = [...new Set(input.rees ?? [])];
    if (refs.length === 0) throw postRefusal('no_rees');
    const rees = await Promise.all(refs.map((ref) => reeIdFor(userId, ref)));
    const fees = Object.fromEntries(rees.map((ree) => [ree.id, maxCostFor(ree, userId)]));
    checkMaxCost(input.max_cost, Object.values(fees).reduce((sum, fee) => sum + fee, 0), 'Asking these Rees');
    const result = await publishPrivatePost(userId, { question: input.question, detail: input.detail ?? '', reeIds: rees.map((ree) => ree.id), fees, lang: caller.user.lang, clientToken }, { source: 'api', apiKeyId: caller.keyId });
    if (!result.ok) {
      if (result.error === 'insufficient_credits') throw insufficientCredits(result.balance, result.needed);
      if (result.error === 'price_changed') throw new McpToolError('price_changed', 'A Ree’s price changed while you asked. Nothing was charged; check get_ree and ask again.', { prices: result.prices });
      throw postRefusal(result.error);
    }
    if (!result.duplicate) defer(quietly(`private post ${result.id}`, () => processPrivatePost(result.id)));
    return { id: result.id, url: postUrl(result.id), visibility: 'private', duplicate: Boolean(result.duplicate), possible_cost: Object.values(fees).reduce((sum, fee) => sum + fee, 0), next: 'The Rees are answering now. Call get_post with this id for their answers and what each cost.' };
  }
  await routeLimit('post', caller);
  checkMaxCost(input.max_cost, PUBLIC_POST_MAX_COST, 'A public post’s automatic answers');
  const mention = input.mention_ree ? await reeIdFor(userId, input.mention_ree) : null;
  const result = await publishPost(userId, {
    question: input.question,
    detail: input.detail ?? '',
    anonymous: input.anonymous === true,
    mentionReeId: mention?.id ?? null,
    quotePostId: input.quote_post_id ?? null,
    quoteAnswerId: input.quote_answer_id ?? null,
    clientToken,
    lang: caller.user.lang,
  });
  if (!result.ok) {
    if (result.error === 'insufficient_credits') throw insufficientCredits(result.balance, result.needed);
    throw postRefusal(result.error);
  }
  if (!result.duplicate) defer(quietly(`post ${result.id}`, () => processPost(result.id)));
  const allowance = await postAllowance(userId);
  return {
    id: result.id,
    url: postUrl(result.id),
    visibility: 'public',
    duplicate: Boolean(result.duplicate),
    possible_cost: PUBLIC_POST_MAX_COST,
    balance: allowance.balance,
    next: 'The post is reviewed, then matching free Rees answer (the base fee each, charged only for answers given). Paid Rees ask first: get_post lists them under paid_requests, and respond_paid_request agrees or declines. Call get_post with this id to follow it.',
  };
}

export interface FollowupInput {
  post: string;
  question: string;
  mention_rees?: string[];
  add_rees?: string[];
  max_cost?: number;
  client_token?: string;
}

/**
 * 追问 under a post: on a public post anyone signed in may (reviewed, then
 * the first round's Rees that are relevant or named answer, each at the base
 * fee); on the caller's own private post, the thread's Rees (or ones added
 * now) answer at their price, held at once.
 */
export async function addFollowupTool(caller: ApiKeyCaller, input: FollowupInput, defer: Defer) {
  requireWrite(caller);
  const userId = caller.user.id;
  const clientToken = input.client_token && isUuid(input.client_token) ? input.client_token : null;
  const isPrivate = await isPrivatePost(input.post);
  await routeLimit(isPrivate ? 'ask' : 'post', caller);
  const mentions = await Promise.all((input.mention_rees ?? []).slice(0, 10).map((ref) => reeIdFor(userId, ref)));
  if (isPrivate) {
    const added = await Promise.all((input.add_rees ?? []).slice(0, 10).map((ref) => reeIdFor(userId, ref)));
    const thread = await privateThreadRees(input.post, userId);
    /* The price of every Ree this follow-up could go to: those named, or else any of the thread's. */
    const named = [...mentions, ...added];
    const candidates = named.length ? named : thread.map((entry) => ({ id: entry.reeId, ownerId: entry.ownerId, queryFee: entry.queryFee }));
    const fees = Object.fromEntries(candidates.map((ree) => [ree.id, maxCostFor(ree, userId)]));
    checkMaxCost(input.max_cost, Object.values(fees).reduce((sum, fee) => sum + fee, 0), 'This follow-up');
    const result = await askPrivateFollowup(userId, input.post, { question: input.question, mentionReeIds: mentions.map((ree) => ree.id), addReeIds: added.map((ree) => ree.id), fees, clientToken, lang: caller.user.lang }, { apiKeyId: caller.keyId });
    if (!result.ok) {
      if (result.error === 'not_found') throw postNotFound(input.post);
      if (result.error === 'insufficient_credits') throw insufficientCredits(result.balance, result.needed);
      if (result.error === 'price_changed') throw new McpToolError('price_changed', 'A Ree’s price changed while you asked. Nothing was charged; ask again.', { prices: result.prices });
      throw postRefusal(result.error);
    }
    if (!result.duplicate) defer(quietly(`private followup ${result.id}`, () => processPrivateFollowup(result.id)));
    return { id: result.id, post_id: input.post, duplicate: Boolean(result.duplicate), next: 'The Rees are answering now. Call get_post for the answers.' };
  }
  if ((input.add_rees ?? []).length) throw invalidInput('add_rees_private_only', 'add_rees is for your own private posts; on a public post mention one of the Rees that answered instead.');
  checkMaxCost(input.max_cost, PUBLIC_POST_MAX_COST, 'A follow-up’s automatic answers');
  const result = await askFollowup(userId, input.post, { question: input.question, mentionReeIds: mentions.map((ree) => ree.id), clientToken, lang: caller.user.lang });
  if (!result.ok) {
    if (result.error === 'not_found') throw postNotFound(input.post);
    if (result.error === 'insufficient_credits') throw insufficientCredits(result.balance, result.needed);
    throw postRefusal(result.error);
  }
  if (!result.duplicate) defer(quietly(`followup ${result.id}`, () => processFollowup(result.id)));
  return { id: result.id, post_id: input.post, duplicate: Boolean(result.duplicate), next: 'The follow-up is reviewed, then the relevant Rees answer (the base fee each, only for answers given). Call get_post to follow it.' };
}

/** Its asker deletes a follow-up: gone for everyone with its answers; what was settled stays settled. */
export async function deleteFollowupTool(caller: ApiKeyCaller, input: { followup: string }) {
  requireWrite(caller);
  if (!(await deleteFollowup(caller.user.id, input.followup))) throw new McpToolError('not_found', `No follow-up "${input.followup}" of yours to delete.`);
  return { deleted: true, followup: input.followup };
}

/** 转为公开: a public copy of the caller's private post and its answers, reviewed like any post; once per post. */
export async function publishPostTool(caller: ApiKeyCaller, input: { post: string; anonymous?: boolean }, defer: Defer) {
  requireWrite(caller);
  await routeLimit('post', caller);
  const result = await convertToPublic(caller.user.id, input.post, { anonymous: input.anonymous === true });
  if (!result.ok) {
    if (result.error === 'already') throw new McpToolError('conflict', 'This private post was already made public.', { public_post_id: result.id, url: postUrl(result.id) });
    throw new McpToolError('not_found', `No private post "${input.post}" of yours to make public.`);
  }
  defer(quietly(`post ${result.id}`, () => processPost(result.id)));
  return { public_post_id: result.id, url: postUrl(result.id), status: 'pending', next: 'The public copy is reviewed before anyone else sees it. Its follow-ups stay private.' };
}

/** The author's own private post: pin, archive, rename (the web's PATCH; trashing is `trash_post`). */
export async function updatePostTool(caller: ApiKeyCaller, input: { post: string; pinned?: boolean; archived?: boolean; title?: string | null }) {
  requireWrite(caller);
  const change = { ...(input.pinned === undefined ? {} : { pinned: input.pinned }), ...(input.archived === undefined ? {} : { archived: input.archived }), ...(input.title === undefined ? {} : { title: input.title }) };
  if (Object.keys(change).length === 0) throw invalidInput('nothing_to_change', 'Pass pinned, archived or title.');
  const result = await updatePrivatePost(caller.user.id, input.post, change);
  if (!result.ok) {
    if (result.error === 'title_too_long') throw invalidInput('title_too_long', `A title is at most ${POST_TITLE_MAX} characters.`);
    throw new McpToolError('not_found', `No private post "${input.post}" of yours. Pinning, archiving and renaming are for your own private posts.`);
  }
  return { id: input.post, pinned: result.pinned, archived: result.archived, title: result.title };
}

/** The author moves their post to the trash (gone from every feed; purged later) or back. */
export async function trashPostTool(caller: ApiKeyCaller, input: { post: string; trashed?: boolean }) {
  requireWrite(caller);
  const trashed = input.trashed !== false;
  if (!(await setPostTrashed(caller.user.id, input.post, trashed))) throw new McpToolError('not_found', `No post "${input.post}" of yours.`);
  return { id: input.post, trashed };
}

/** 收藏 a post the caller can see, or not. */
export async function savePostTool(caller: ApiKeyCaller, input: { post: string; saved?: boolean }) {
  requireWrite(caller);
  await routeLimit('postAction', caller);
  const saved = input.saved !== false;
  if (!(await setPostSaved(caller.user.id, input.post, saved))) throw postNotFound(input.post);
  return { id: input.post, saved };
}

/** 有帮助 on a post or on one of its answers, or taken back. */
export async function markHelpfulTool(caller: ApiKeyCaller, input: { post?: string; answer?: string; helpful?: boolean }) {
  requireWrite(caller);
  if (Boolean(input.post) === Boolean(input.answer)) throw invalidInput('one_target', 'Pass exactly one of post or answer.');
  await routeLimit('postAction', caller);
  const on = input.helpful !== false;
  const result = input.answer ? await setAnswerHelpful(caller.user.id, input.answer, on) : await setPostHelpful(caller.user.id, input.post!, on);
  if (!result) throw new McpToolError('not_found', `No ${input.answer ? 'answer' : 'post'} "${input.answer ?? input.post}" you can mark.`);
  return { ...(input.answer ? { answer: input.answer } : { post: input.post }), helpful: result.helpful, voted_helpful: result.voted };
}

/**
 * A Ree's request to answer the caller's post or follow-up (a paid Ree, or
 * a free one their balance could not cover): agree at no more than
 * `max_cost` (held, then answered) or decline.
 */
export async function respondPaidRequestTool(caller: ApiKeyCaller, input: { request: string; action: 'agree' | 'decline'; max_cost?: number }, defer: Defer) {
  requireWrite(caller);
  await routeLimit('postAction', caller);
  const userId = caller.user.id;
  if (input.action === 'decline') {
    if (!(await declinePaidAnswer(userId, input.request))) throw new McpToolError('not_found', `No request "${input.request}" waiting for you.`);
    return { request: input.request, declined: true };
  }
  if (input.max_cost === undefined) throw invalidInput('max_cost_required', 'Pass max_cost: the price get_post showed for this request (the most you agree to pay).');
  const result = await agreePaidAnswer(userId, input.request, input.max_cost);
  if (!result.ok) {
    switch (result.error) {
      case 'price_changed':
        throw new McpToolError('max_cost_exceeded', `This answer now costs ${result.price} credits, above your max_cost of ${input.max_cost}. Nothing was charged.`, { possible_cost: result.price, max_cost: input.max_cost });
      case 'insufficient':
        throw insufficientCredits(result.balance, result.needed);
      case 'unavailable':
        throw new McpToolError('conflict', 'This Ree can no longer answer here; the request is closed and nothing was charged.', { reason: 'unavailable' });
      case 'already':
        throw new McpToolError('conflict', 'You already agreed to this answer.', { reason: 'already' });
      default:
        throw new McpToolError('not_found', `No request "${input.request}" waiting for you.`);
    }
  }
  defer(quietly(`paid answer ${input.request}`, () => answerPaid(input.request)));
  return { request: input.request, agreed: true, next: 'The Ree is answering now. Call get_post for the answer.' };
}
