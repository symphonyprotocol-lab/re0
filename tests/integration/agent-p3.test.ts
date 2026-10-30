/**
 * Phase P3 against a real database (agent-first-proposal.md 13.1, P3a and
 * P3b rows):
 *
 * - a non-subscriber gets no `paid` body through the web reading page, A2A
 *   or REST; a subscriber does; the next call after the subscription's
 *   period ends is refused on all three;
 * - comments never appear in any retrieval result;
 * - the first channel subscription raises the subscriber to 2 GB;
 * - a chargeback that reverses income already paid out leaves a negative
 *   balance, and then the creator can neither withdraw nor open a paid plan;
 * - a plan below the configured minimum is refused for monthly and yearly
 *   alike, and a raised minimum stops an older plan selling;
 * - a non-subscriber gets no signed URL for paid audio; audio counts toward
 *   capacity.
 *
 * Builds run the real `editor`/`audio` connector through `runOperation`;
 * Paddle is replaced by fabricated, already-verified notifications fed to
 * the webhook use case.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
process.env.API_KEY_HASH_SECRET ??= 'test-api-key-hash-secret-000000000000';
process.env.APP_BASE_URL ??= 'https://app.example.test';

const { memoryObjectStore, runOperation } = await import('@/lib/application/ingestion');
const { fetchSnapshot } = await import('@/lib/infrastructure/connectors');
const editorial = await import('@/lib/application/editorial');
const channels = await import('@/lib/application/channels');
const subscriptions = await import('@/lib/application/channels/subscriptions');
const comments = await import('@/lib/application/comments');
const { applyPaymentNotification } = await import('@/lib/application/billing/webhook');
const { queryDocs } = await import('@/lib/application/retrieval/query-docs');
const { searchScope } = await import('@/lib/application/retrieval/search-scope');
const { requestPayout, redeemEarningsAsCalls, creatorBalance } = await import('@/lib/application/revenue');
const { generateSettlements, markPayoutPaid, updateCommerceConfig } = await import('@/lib/application/administration');
const { workspaceStorage } = await import('@/lib/application/plans/storage');
const { storageCapacityBytes } = await import('@/lib/domain/plans');
const { buildAgentCard } = await import('@/lib/application/a2a/card');
const { handleA2A } = await import('@/lib/application/a2a/server');
const { resolveTenant } = await import('@/lib/application/a2a/tenant');
const { hashApiKey } = await import('@/lib/application/auth/api-key');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { GET: contextRoute } = await import('@/app/api/v1/context/route');

type A2ATenant = import('@/lib/application/a2a/tenant').A2ATenant;
type CallerContext = import('@/lib/application/retrieval').CallerContext;

const stamp = Date.now().toString(36);
const store = memoryObjectStore();
const workspaces: string[] = [];
const users: string[] = [];
const planVersions: string[] = [];
const commerceConfigs: string[] = [];
const administratorId = uuidv7();
const OPERATOR = { administratorId, email: 'p3-ops@example.test' };
const RIGHTS = { origin: 'own', license: 'granted', generation: 'human' };

const noModels = {
  embeddings: () => {
    throw new Error('not configured');
  },
  rerank: () => {
    throw new Error('not configured');
  },
  cache: () => ({ get: async () => null, set: async () => {}, invalidateTag: async () => {} }),
  configured: () => ({ embeddings: false, rerank: false }),
};

/** The real connectors (the editor source reads its own config), fake embeddings, a memory bucket. */
const ingestion = {
  fetchSnapshot,
  embeddings: () => ({
    model: 'fixture-embed-p3',
    dimensions: EMBEDDING_COLUMN_DIMENSIONS,
    async embed(texts: string[]) {
      return texts.map((text) => Array.from({ length: EMBEDDING_COLUMN_DIMENSIONS }, (_, i) => ((text.length + i) % 13) / 13));
    },
  }),
  store: () => store,
  configured: () => ({ embeddings: true, storage: true }),
};

interface Person {
  userId: string;
  workspaceId: string;
  key: string;
}

/** A user with a personal workspace (owner), a plan with an allowance, a handle and an API key. */
async function person(label: string): Promise<Person> {
  const database = db();
  const userId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  users.push(userId);
  workspaces.push(workspaceId);
  await database.insert(schema.user).values({ id: userId, email: `${label}-${stamp}@example.test`, displayName: `P3 ${label}` });
  await database.insert(schema.workspace).values({ id: workspaceId, name: `P3 ${label}`, handle: `p3-${label}-${stamp}` });
  await database.insert(schema.workspaceMember).values({ workspaceId, userId, role: 'owner' });
  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'free',
    priceMinor: 0,
    currency: 'USD',
    monthlyCalls: 1_000,
    apiKeyLimit: 5,
    capabilities: {},
    createdAt: new Date('2000-01-01T00:00:00Z'),
  });
  await database.insert(schema.subscription).values({
    id: uuidv7(),
    workspaceId,
    planVersionId,
    status: 'active',
    periodStart: new Date(Date.now() - 86_400_000),
    periodEnd: new Date(Date.now() + 30 * 86_400_000),
  });
  const key = `mm_test_${crypto.randomUUID().replace(/-/g, '')}`;
  await database.insert(schema.apiKey).values({
    id: uuidv7(),
    workspaceId,
    name: 'p3 key',
    keyHash: await hashApiKey(key),
    keyPrefix: 'mm_test_',
    lastFour: key.slice(-4),
    scopes: ['retrieval', 'knowledge:search'],
    environment: 'test',
  });
  return { userId, workspaceId, key };
}

function owner(p: Person) {
  return { workspaceId: p.workspaceId, role: 'owner' as const, userId: p.userId };
}

async function build(operationId: string | null): Promise<void> {
  if (!operationId) throw new Error('no build queued');
  const outcome = await runOperation({ operationId, dependencies: ingestion });
  if (outcome.status !== 'succeeded' && outcome.status !== 'skipped') {
    throw new Error(`build ${operationId}: ${JSON.stringify(outcome)}`);
  }
}

/** A selling channel of `creator`'s, with a monthly and a yearly plan. */
async function sellingChannel(creator: Person, slug: string) {
  const channel = await channels.createChannel({ ...owner(creator), slug: `${slug}-${stamp}`, title: `P3 ${slug}` });
  await subscriptions.enableSubscriptions({ ...owner(creator), channelId: channel.id, confirmRights: true });
  const monthly = await subscriptions.setChannelPlan({ ...owner(creator), channelId: channel.id, interval: 'month', price: '6' });
  const yearly = await subscriptions.setChannelPlan({ ...owner(creator), channelId: channel.id, interval: 'year', price: '60' });
  return { ...channel, monthly, yearly };
}

/** A published post in `channelId` with `body`, built for real. */
async function publishedPost(creator: Person, input: { slug: string; title: string; body: string; channelId: string; access: 'free' | 'paid' }) {
  const created = await editorial.createEditorialAsset({ ...owner(creator), kind: 'post', title: input.title, slug: `${input.slug}-${stamp}`, rights: RIGHTS });
  await editorial.saveEditorialDraft({ ...owner(creator), assetId: created.assetId, title: input.title, body: input.body, channelId: input.channelId, access: input.access });
  const published = await editorial.publishEditorial({ ...owner(creator), assetId: created.assetId });
  await build(published.operationId);
  return created;
}

let transactionSeq = 0;

/** What Paddle's verified `transaction.completed` (and later adjustments) look like to the use case. */
function channelTransaction(input: {
  planVersionId: string;
  subscriber: Person;
  subscriptionId: string;
  transactionId?: string;
  exTaxMinor: number;
  collectedAt?: Date;
  periodEnd?: Date;
  adjustments?: { id: string; action: 'refund' | 'chargeback' | 'chargeback_reverse'; exTaxMinor: number; at?: Date }[];
}) {
  transactionSeq += 1;
  const collectedAt = input.collectedAt ?? new Date();
  return {
    provider: 'paddle',
    externalEventId: `evt_p3_${stamp}_${transactionSeq}`,
    eventType: 'transaction.completed',
    payload: {},
    subject: 'channel_transaction' as const,
    channel: {
      transactionId: input.transactionId ?? `txn_p3_${stamp}_${transactionSeq}`,
      subscriptionExternalId: input.subscriptionId,
      customerId: `ctm_p3_${stamp}`,
      state: 'collected' as const,
      channelPlanVersionId: input.planVersionId,
      userId: input.subscriber.userId,
      workspaceId: input.subscriber.workspaceId,
      exTaxMinor: input.exTaxMinor,
      currency: 'USD',
      collectedAt,
      periodEnd: input.periodEnd ?? new Date(collectedAt.getTime() + 30 * 86_400_000),
      adjustments: (input.adjustments ?? []).map((adjustment) => ({
        id: adjustment.id,
        action: adjustment.action,
        status: 'approved',
        exTaxMinor: adjustment.exTaxMinor,
        observedAt: adjustment.at ?? new Date(),
      })),
      observedAt: new Date(),
    },
  };
}

function caller(workspaceId: string | null, entrypoint: CallerContext['entrypoint'] = 'a2a'): CallerContext {
  return { workspaceId, apiKeyId: null, requestId: `req_${crypto.randomUUID()}`, anonymous: workspaceId === null, entrypoint };
}

async function a2aSearch(tenant: A2ATenant, workspaceId: string | null, query: string) {
  const requestId = `req_${crypto.randomUUID()}`;
  const result = await handleA2A({
    method: 'POST',
    rest: [],
    search: new URLSearchParams(),
    body: { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: query }] } } },
    version: '1.0',
    card: buildAgentCard({ origin: 'https://app.example.test', tenant }),
    origin: 'https://app.example.test',
    pathTenant: true,
    facts: {
      caller: { workspaceId, apiKeyId: null, requestId, anonymous: workspaceId === null, entrypoint: 'a2a' },
      tenant,
      anonymousVisitor: workspaceId ? null : `anon-p3-${stamp}`,
    },
  });
  if (result.kind !== 'json') throw new Error(`expected JSON, got ${result.kind}`);
  const task = (result.body as { result: { task: { artifacts: { parts: { data?: { results: { assetId: string; text: string }[] } }[] }[] } } }).result.task;
  return task.artifacts[0]!.parts.find((part) => part.data)!.data!.results;
}

async function rest(key: string, publicId: string, query: string): Promise<Response> {
  return contextRoute(
    new NextRequest(
      `https://api.example.test/api/v1/context?assetId=${encodeURIComponent(publicId)}&query=${encodeURIComponent(query)}&maxTokens=4000`,
      { headers: { authorization: `Bearer ${key}` } },
    ),
  );
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
  return 'resolved';
}

describeWithDb('P3: articles, comments, subscriptions, payouts and audio', () => {
  beforeAll(async () => {
    await db().insert(schema.administrator).values({
      id: administratorId,
      email: OPERATOR.email,
      username: `p3-ops-${stamp}`,
      passwordHash: 'unused',
      status: 'active',
    });
  });

  afterAll(async () => {
    const database = db();
    const assets = (await database.select({ id: schema.asset.id }).from(schema.asset).where(inArray(schema.asset.ownerWorkspaceId, workspaces))).map((row) => row.id);
    if (assets.length > 0) {
      await database.update(schema.asset).set({ currentVersionId: null }).where(inArray(schema.asset.id, assets));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.assetId, assets));
      await database.delete(schema.assetProfileVector).where(inArray(schema.assetProfileVector.assetId, assets));
      await database.delete(schema.assetProfile).where(inArray(schema.assetProfile.assetId, assets));
      await database.delete(schema.chunk).where(inArray(schema.chunk.assetId, assets));
      await database.delete(schema.document).where(inArray(schema.document.assetId, assets));
      await database.delete(schema.assetScore).where(inArray(schema.assetScore.assetId, assets));
      await database.delete(schema.assetVersion).where(inArray(schema.assetVersion.assetId, assets));
      await database.delete(schema.workflowOperation).where(inArray(schema.workflowOperation.assetId, assets));
      await database.delete(schema.source).where(inArray(schema.source.assetId, assets));
      await database.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, assets));
      /* Comments, drafts, media and channel membership cascade with the asset. */
      await database.delete(schema.asset).where(inArray(schema.asset.id, assets));
    }
    if (workspaces.length > 0) {
      const accounts = (await database.select({ id: schema.publisherAccount.id }).from(schema.publisherAccount).where(inArray(schema.publisherAccount.workspaceId, workspaces))).map((row) => row.id);
      if (accounts.length > 0) {
        await database.delete(schema.settlement).where(inArray(schema.settlement.publisherAccountId, accounts));
        await database.delete(schema.payout).where(inArray(schema.payout.publisherAccountId, accounts));
        await database.delete(schema.publisherAccount).where(inArray(schema.publisherAccount.id, accounts));
      }
      await database.delete(schema.earningEvent).where(inArray(schema.earningEvent.ownerWorkspaceId, workspaces));
      await database.delete(schema.requestLog).where(inArray(schema.requestLog.workspaceId, workspaces));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.workspaceId, workspaces));
      await database.delete(schema.usageReservation).where(inArray(schema.usageReservation.workspaceId, workspaces));
      await database.delete(schema.usageSummary).where(inArray(schema.usageSummary.workspaceId, workspaces));
      await database.delete(schema.subscription).where(inArray(schema.subscription.workspaceId, workspaces));
      await database.delete(schema.apiKey).where(inArray(schema.apiKey.workspaceId, workspaces));
      await database.delete(schema.channelSubscription).where(inArray(schema.channelSubscription.workspaceId, workspaces));
      await database.delete(schema.workspaceMember).where(inArray(schema.workspaceMember.workspaceId, workspaces));
      /* Channels, plans, questions, twin answers and visits cascade with the workspace. */
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    await database.delete(schema.revenuePeriod).where(like(schema.revenuePeriod.id, '2019-0%'));
    await database.delete(schema.paymentEvent).where(like(schema.paymentEvent.externalEventId, `evt_p3_${stamp}_%`));
    if (users.length > 0) {
      await database.delete(schema.notification).where(inArray(schema.notification.userId, users));
      await database.delete(schema.workspaceMember).where(inArray(schema.workspaceMember.userId, users));
      await database.delete(schema.user).where(inArray(schema.user.id, users));
    }
    if (planVersions.length > 0) await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
    if (commerceConfigs.length > 0) await database.delete(schema.commerceConfig).where(inArray(schema.commerceConfig.id, commerceConfigs));
    await database.delete(schema.auditLog).where(eq(schema.auditLog.administratorId, administratorId));
    await database.delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
  });

  it('keeps a paid body from non-subscribers on the web, over A2A and REST, and refuses the next call after expiry', async () => {
    const creator = await person('creator');
    const reader = await person('reader');
    const stranger = await person('stranger');
    const channel = await sellingChannel(creator, 'p3-paid');
    const post = await publishedPost(creator, {
      slug: 'marigold',
      title: 'Marigold lantern craft',
      body: 'The marigold lanterns burn longest on rendered tallow and a braided cotton wick.',
      channelId: channel.id,
      access: 'paid',
    });
    const [row] = await db().select({ access: schema.asset.access, lifecycle: schema.asset.lifecycleStatus }).from(schema.asset).where(eq(schema.asset.id, post.assetId));
    expect(row).toEqual({ access: 'paid', lifecycle: 'published' });

    const tenant = (await resolveTenant(`channels/${channel.slug}`))!;
    const query = 'marigold lanterns tallow wick';
    const blocked = async (who: Person | null) => {
      const reading = await editorial.editorialReading(post.publicId, { workspaceId: who?.workspaceId ?? null });
      expect(reading?.sight).toBe('summary');
      expect(reading?.body).toBeNull();
      expect((await a2aSearch(tenant, who?.workspaceId ?? null, query)).filter((hit) => hit.assetId === post.publicId)).toHaveLength(0);
      if (who) {
        expect((await rest(who.key, post.publicId, query)).status).toBe(404);
        expect(await refusal(queryDocs(caller(who.workspaceId, 'rest'), { assetId: post.publicId, query, maxTokens: 4000, format: 'json' }, noModels))).toBe('library_not_found');
      }
    };

    /* Nobody but the owner reads it before a subscription. */
    for (const who of [reader, stranger, null]) await blocked(who);
    expect((await editorial.editorialReading(post.publicId, { workspaceId: creator.workspaceId }))?.body).toContain('braided cotton wick');

    /* The reader subscribes: the webhook records it and the paid body opens on all three doors. */
    const subscriptionId = `sub_p3_${stamp}_paid`;
    expect(await applyPaymentNotification(channelTransaction({ planVersionId: channel.monthly.id, subscriber: reader, subscriptionId, exTaxMinor: 600 }))).toBe('applied');
    const reading = await editorial.editorialReading(post.publicId, { workspaceId: reader.workspaceId });
    expect(reading?.sight).toBe('full');
    expect(reading?.body).toContain('braided cotton wick');
    expect((await a2aSearch(tenant, reader.workspaceId, query)).some((hit) => hit.assetId === post.publicId)).toBe(true);
    expect((await rest(reader.key, post.publicId, query)).status).toBe(200);
    /* The channel's extended card tells a subscriber its skills now reach the paid assets. */
    const card = buildAgentCard({ origin: 'https://app.example.test', tenant, extended: { workspaceId: reader.workspaceId, quota: { planAllowanceRemaining: 0, addonBalanceRemaining: 0, capacityBytes: 0, usedBytes: 0, askCallsPerAnswer: 10, askDailyAnswers: 500, answersToday: 0 }, subscribes: true } });
    expect(JSON.stringify(card.skills)).toContain('subscriber-only (paid)');
    for (const who of [stranger, null]) await blocked(who);

    /* Its period ends: the very next call is refused everywhere, before any webhook says so. */
    await db()
      .update(schema.channelSubscription)
      .set({ currentPeriodEnd: new Date(Date.now() - 1_000) })
      .where(eq(schema.channelSubscription.providerSubscriptionId, subscriptionId));
    await blocked(reader);
  });

  it('keeps a paid post paid when publishing moves it, and refuses a schedule with no time', async () => {
    const creator = await person('mv');
    const first = await sellingChannel(creator, 'p3-mv-a');
    const second = await sellingChannel(creator, 'p3-mv-b');
    const post = await publishedPost(creator, { slug: 'moved', title: 'Moved post', body: 'Moss grows on the north side.', channelId: first.id, access: 'paid' });
    await editorial.saveEditorialDraft({ ...owner(creator), assetId: post.assetId, title: 'Moved post', body: 'Moss grows on the north side, mostly.', channelId: second.id, access: 'paid' });
    expect(await refusal(editorial.publishEditorial({ ...owner(creator), assetId: post.assetId, publishAt: '', schedule: true }))).toBe('invalid_schedule');
    await build((await editorial.publishEditorial({ ...owner(creator), assetId: post.assetId })).operationId);
    const [row] = await db()
      .select({ access: schema.asset.access, channelId: schema.channelAsset.channelId })
      .from(schema.asset)
      .innerJoin(schema.channelAsset, eq(schema.channelAsset.assetId, schema.asset.id))
      .where(eq(schema.asset.id, post.assetId));
    expect(row).toEqual({ access: 'paid', channelId: second.id });
  });

  it('never lets a comment into retrieval', async () => {
    const creator = await person('cmt');
    const reader = await person('cmtr');
    const channel = await channels.createChannel({ ...owner(creator), slug: `p3-cmt-${stamp}`, title: 'P3 comments' });
    const post = await publishedPost(creator, {
      slug: 'heron',
      title: 'Heron watching',
      body: 'Grey herons stand still in the shallows at dawn.',
      channelId: channel.id,
      access: 'free',
    });
    const word = `quokkabloom${stamp}`;
    const posted = await comments.postComment({ userId: reader.userId, workspaceId: reader.workspaceId, assetId: post.assetId, body: `Lovely! ${word} is my favourite word.` });
    expect(posted.hidden).toBe(false);
    const thread = await comments.listComments(post.assetId, { userId: null, workspaceId: null });
    expect(thread.comments.map((comment) => comment.body).join(' ')).toContain(word);

    /* A new version after the comment: still built from the creator's text alone. */
    await editorial.saveEditorialDraft({ ...owner(creator), assetId: post.assetId, title: 'Heron watching', body: 'Grey herons stand still in the shallows at dawn and dusk.', channelId: channel.id, access: 'free' });
    await build((await editorial.publishEditorial({ ...owner(creator), assetId: post.assetId })).operationId);

    const chunks = await db().select({ body: schema.chunk.body }).from(schema.chunk).where(eq(schema.chunk.assetId, post.assetId));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some((chunk) => chunk.body.includes(word))).toBe(false);
    for (const who of [reader.workspaceId, null]) {
      const scoped = await searchScope(caller(who), { scope: { kind: 'channel', channelId: channel.id }, query: word, maxTokens: 4000 }, noModels);
      expect(scoped.chunks.some((chunk) => chunk.text.includes(word))).toBe(false);
      const one = await queryDocs(caller(who), { assetId: post.publicId, query: word, maxTokens: 4000, format: 'json' }, noModels).catch(() => null);
      expect(JSON.stringify(one ?? {})).not.toContain(word);
    }
  });

  it('raises the subscriber to 2 GB with the first channel subscription', async () => {
    const creator = await person('tier');
    const reader = await person('tierr');
    const channel = await sellingChannel(creator, 'p3-tier');
    expect((await workspaceStorage(reader.workspaceId)).capacityBytes).toBe(storageCapacityBytes('base'));
    await applyPaymentNotification(channelTransaction({ planVersionId: channel.yearly.id, subscriber: reader, subscriptionId: `sub_p3_${stamp}_tier`, exTaxMinor: 6_000 }));
    expect((await workspaceStorage(reader.workspaceId)).capacityBytes).toBe(storageCapacityBytes('extended'));
    /* The creator's share: 80% of the ex-tax subtotal, frozen with the plan's fee. */
    const [event] = await db().select().from(schema.earningEvent).where(and(eq(schema.earningEvent.ownerWorkspaceId, creator.workspaceId), eq(schema.earningEvent.source, 'channel_subscription')));
    expect(event).toMatchObject({ amountMinor: 4_800, grossMinor: 6_000, shareBps: 8_000 });
  });

  it('leaves a negative balance when a chargeback reverses paid-out income, and then blocks payouts and new paid plans', async () => {
    const creator = await person('cb');
    const reader = await person('cbr');
    const channel = await sellingChannel(creator, 'p3-cb');
    const transactionId = `txn_p3_${stamp}_cb`;
    const collectedAt = new Date(Date.UTC(2019, 2, 10));
    const sale = (adjustments: { id: string; action: 'chargeback'; exTaxMinor: number }[] = []) =>
      channelTransaction({ planVersionId: channel.yearly.id, subscriber: reader, subscriptionId: `sub_p3_${stamp}_cb`, transactionId, exTaxMinor: 6_000, collectedAt, periodEnd: new Date(Date.now() + 300 * 86_400_000), adjustments });
    await applyPaymentNotification(sale());

    /* The month closes, the statement is past its 120-day hold, the profile is complete, and the payout is sent. */
    await generateSettlements({ actor: OPERATOR, periodId: '2019-03', reason: 'P3 fixture close' });
    await db().update(schema.revenuePeriod).set({ lockedAt: new Date(Date.now() - 200 * 86_400_000) }).where(eq(schema.revenuePeriod.id, '2019-03'));
    expect(await refusal(requestPayout({ workspaceId: creator.workspaceId, actor: { kind: 'user', id: creator.userId }, payeeEmail: 'creator@example.test' }))).toBe('profile_incomplete');
    await db().update(schema.publisherAccount).set({ taxFormKind: 'W-9', taxFormStatus: 'verified', payeeEmail: 'creator@example.test' }).where(eq(schema.publisherAccount.workspaceId, creator.workspaceId));
    const requested = await requestPayout({ workspaceId: creator.workspaceId, actor: { kind: 'user', id: creator.userId } });
    expect(requested.amountMinor).toBe(4_800);
    await markPayoutPaid({ actor: OPERATOR, payoutId: requested.payoutId, reference: 'PAYPAL-P3-1', reason: 'sent' });
    expect((await creatorBalance(creator.workspaceId)).balanceMinor).toBe(0);

    /* The card company takes the payment back: the same transaction re-read with a chargeback. */
    await applyPaymentNotification(sale([{ id: `adj_p3_${stamp}_cb`, action: 'chargeback', exTaxMinor: 6_000 }]));
    expect((await creatorBalance(creator.workspaceId)).balanceMinor).toBe(-4_800);
    /* A redelivery writes nothing twice. */
    await applyPaymentNotification(sale([{ id: `adj_p3_${stamp}_cb`, action: 'chargeback', exTaxMinor: 6_000 }]));
    expect((await creatorBalance(creator.workspaceId)).balanceMinor).toBe(-4_800);
    /* The chargeback revoked the subscription it reversed. */
    expect(await subscriptions.subscribesTo(reader.workspaceId, channel.id)).toBe(false);

    expect(await refusal(requestPayout({ workspaceId: creator.workspaceId, actor: { kind: 'user', id: creator.userId } }))).toBe('negative_balance');
    expect(await refusal(redeemEarningsAsCalls({ workspaceId: creator.workspaceId, actor: { kind: 'user', id: creator.userId } }))).toBe('negative_balance');
    for (const interval of ['month', 'year']) {
      expect(await refusal(subscriptions.setChannelPlan({ ...owner(creator), channelId: channel.id, interval, price: '9' }))).toBe('negative_balance');
    }
  });

  it('refuses a transaction below the configured minimum for monthly and yearly plans alike', async () => {
    const creator = await person('min');
    const reader = await person('minr');
    const channel = await sellingChannel(creator, 'p3-min');
    for (const interval of ['month', 'year']) {
      expect(await refusal(subscriptions.setChannelPlan({ ...owner(creator), channelId: channel.id, interval, price: '4.99' }))).toBe('below_minimum');
      expect((await subscriptions.setChannelPlan({ ...owner(creator), channelId: channel.id, interval, price: '5' })).priceMinor).toBe(500);
    }
    /* The console raises the minimum: the $5 plans stop selling, monthly and yearly. */
    const { configId } = await updateCommerceConfig({
      actor: OPERATOR,
      values: { minPriceMinor: 700, feeRateBps: 2_000, payoutHoldDays: 120, payoutThresholdMinor: 2_000 },
      reason: 'P3 fixture: fee basis turned out tax-inclusive',
    });
    commerceConfigs.push(configId);
    const adapter = { createChannelCheckout: async () => ({ externalId: 'txn_never', url: 'https://pay.example.test' }) } as never;
    try {
      for (const interval of ['month', 'year']) {
        expect(await refusal(subscriptions.startChannelCheckout({ userId: reader.userId, workspaceId: reader.workspaceId, channelId: channel.id, interval }, adapter))).toBe('below_minimum');
        expect(await refusal(subscriptions.setChannelPlan({ ...owner(creator), channelId: channel.id, interval, price: '6.99' }))).toBe('below_minimum');
      }
      await subscriptions.setChannelPlan({ ...owner(creator), channelId: channel.id, interval: 'month', price: '7' });
      expect(await subscriptions.startChannelCheckout({ userId: reader.userId, workspaceId: reader.workspaceId, channelId: channel.id, interval: 'month' }, adapter)).toBe('https://pay.example.test');
    } finally {
      await db().delete(schema.commerceConfig).where(eq(schema.commerceConfig.id, configId));
    }
  });

  it('signs paid audio only for entitled readers and counts it toward capacity', async () => {
    const creator = await person('aud');
    const reader = await person('audr');
    const stranger = await person('auds');
    const channel = await sellingChannel(creator, 'p3-aud');
    const episode = await editorial.createEditorialAsset({ ...owner(creator), kind: 'audio', title: 'Episode one', slug: `ep1-${stamp}`, rights: RIGHTS });
    const before = await workspaceStorage(creator.workspaceId);

    const bytes = new Uint8Array(4_096).map((_, i) => i % 251);
    const prepared = await editorial.prepareMediaUpload({ ...owner(creator), assetId: episode.assetId, kind: 'audio', name: 'ep1.mp3', size: bytes.length, contentType: 'audio/mpeg', store });
    const objectKey = (prepared.ticket as { url: string }).url.replace(/^memory:\/\//, '').replace(/\?upload$/, '');
    await store.put(objectKey, bytes, 'audio/mpeg');
    await editorial.confirmMediaUpload({ ...owner(creator), mediaId: prepared.mediaId, store });
    expect((await workspaceStorage(creator.workspaceId)).usedBytes).toBe(before.usedBytes + bytes.length);

    /* An upload the remaining capacity cannot hold is refused before a ticket is issued. */
    const after = await workspaceStorage(creator.workspaceId);
    await db().update(schema.asset).set({ storageBytes: after.remainingBytes - 1_000 }).where(eq(schema.asset.id, episode.assetId));
    expect(await refusal(editorial.prepareMediaUpload({ ...owner(creator), assetId: episode.assetId, kind: 'audio', name: 'more.wav', size: 2_000, contentType: 'audio/wav', store }))).toBe('storage_exceeded');
    await db().update(schema.asset).set({ storageBytes: 0 }).where(eq(schema.asset.id, episode.assetId));

    await editorial.saveEditorialDraft({ ...owner(creator), assetId: episode.assetId, title: 'Episode one', body: 'Show notes: we talk about pressed flowers.', channelId: channel.id, access: 'paid' });
    await build((await editorial.publishEditorial({ ...owner(creator), assetId: episode.assetId })).operationId);
    /* Only the notes are indexed; the document's path carries the file's hash. */
    const documents = await db().select({ title: schema.document.title, sourceUrl: schema.document.sourceUrl }).from(schema.document).where(eq(schema.document.assetId, episode.assetId));
    expect(documents.length).toBeGreaterThan(0);

    expect(await editorial.mediaUrlFor(stranger.workspaceId, prepared.mediaId, store)).toBeNull();
    expect(await editorial.mediaUrlFor(null, prepared.mediaId, store)).toBeNull();
    expect(await editorial.mediaUrlFor(reader.workspaceId, prepared.mediaId, store)).toBeNull();
    expect((await editorial.mediaUrlFor(creator.workspaceId, prepared.mediaId, store))?.kind).toBe('audio');
    await applyPaymentNotification(channelTransaction({ planVersionId: channel.monthly.id, subscriber: reader, subscriptionId: `sub_p3_${stamp}_aud`, exTaxMinor: 600 }));
    expect((await editorial.mediaUrlFor(reader.workspaceId, prepared.mediaId, store))?.url).toContain(objectKey);
    expect(await editorial.mediaUrlFor(stranger.workspaceId, prepared.mediaId, store)).toBeNull();
    expect((await editorial.editorialReading(episode.publicId, { workspaceId: stranger.workspaceId }))?.audioMediaId).toBeNull();
  });
});
