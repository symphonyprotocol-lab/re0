/**
 * Agent Cards, one generator for three levels (agent-first-proposal.md 7.1,
 * 7.2, 7.3, 7.5):
 *
 * | level    | served at                                   | tenant            | public skills                         |
 * | platform | /.well-known/agent-card.json                | ''                | find_channels, search_context, ask    |
 * | user     | /a2a/users/{handle}/agent-card.json         | users/{handle}    | search_context, ask (if any public channel) |
 * | channel  | /a2a/channels/{slug}/agent-card.json        | channels/{slug}   | search_context, ask                   |
 *
 * The authenticated extended card (`GetExtendedAgentCard`) adds the write
 * skills where they apply (proposal 7.2): on the platform card `ingest`,
 * `refresh` and `publish` over the caller's own workspace; on a user card,
 * for that user's own key only, the same three plus retrieval over all of
 * their assets. A channel's extended card, for a workspace that subscribes
 * to the channel, widens its skills to the channel's `paid` assets -- the
 * calls themselves are what enforce it, through the same visibility rule
 * the web uses. The extended card also states the caller workspace's quota,
 * capacity and daily answer limit -- as facts in the description and as the
 * params of a re0 extension -- and never an internal address or credential
 * (A2A specification 13.3). The public cards never list a write skill.
 *
 * Every card declares the one A2A server twice, JSON-RPC and HTTP+JSON, at
 * protocol 1.0 with the level's tenant; and once more as JSON-RPC at 0.3,
 * the SDK's compatibility mode, where the tenant rides in the URL path
 * because v0.3 clients have no tenant field. v0.3 over HTTP+JSON is not
 * offered: its wire codecs are internal to the SDK's Express router, and
 * v0.3 clients connect over JSON-RPC. Auth is a Bearer API key: optional for
 * the retrieval skills, required for `ask` and the write skills.
 *
 * The description says what makes re0's results different: every passage
 * carries its asset, version and that version's on-chain anchor, checkable
 * with the public Verifier without calling re0 again; and it states the
 * confirmation convention -- a write waits in `INPUT_REQUIRED` for a person,
 * the asset's owner, never for the caller (proposal 7.6).
 */
import { AgentCard } from '@a2a-js/sdk';
import type { A2ATenant } from './tenant';

export const A2A_PROTOCOL_VERSION = '1.0';
export const A2A_LEGACY_VERSION = '0.3';
export const AGENT_CARD_VERSION = '1.0.0';

export const SKILL_FIND_CHANNELS = 'find_channels';
export const SKILL_SEARCH_CONTEXT = 'search_context';
export const SKILL_ASK = 'ask';
export const SKILL_INGEST = 'ingest';
export const SKILL_REFRESH = 'refresh';
export const SKILL_PUBLISH = 'publish';
export const WRITE_SKILLS = [SKILL_INGEST, SKILL_REFRESH, SKILL_PUBLISH] as const;
export type A2AWriteSkill = (typeof WRITE_SKILLS)[number];
export type A2ASkill = typeof SKILL_FIND_CHANNELS | typeof SKILL_SEARCH_CONTEXT | typeof SKILL_ASK | A2AWriteSkill;

/** The re0 extension the extended card carries its quota facts in. */
export const QUOTA_EXTENSION_URI = 'https://re0.io/a2a/extensions/workspace-quota/v1';

/** The caller workspace's standing, for the extended card (proposal 7.2). */
export interface CallerQuota {
  planAllowanceRemaining: number;
  addonBalanceRemaining: number;
  capacityBytes: number;
  usedBytes: number;
  askCallsPerAnswer: number;
  askDailyAnswers: number;
  answersToday: number;
}

export interface CardFacts {
  /** The deployment's origin, `https://re0.io` in production. */
  origin: string;
  tenant: A2ATenant;
  /** For a user card: whether the user has any public channel, without which it has no public skills. */
  hasPublicChannel?: boolean;
  /**
   * Set for the authenticated extended card: who is calling and their
   * standing. Absent, the card is the public one.
   */
  extended?: {
    workspaceId: string;
    quota: CallerQuota;
    /**
     * For a channel card: whether the caller's workspace subscribes to the
     * channel right now, which widens its skills to the channel's `paid`
     * assets (proposal 7.1). Read when the card is built, so the next card
     * after an expiry says free only -- and every call checks again anyway.
     */
    subscribes?: boolean;
  };
}

const VERIFIABLE =
  'Every passage comes back with its source URL, its asset ID, the immutable version it was read from and that ' +
  "version's on-chain anchor, so a caller can verify the version independently with the public Verifier, without " +
  'calling re0 again.';

const HOW_TO_CALL =
  'Send a text message with the question. To pick a skill explicitly, set message metadata `skill`, or include a ' +
  'data part such as {"skill":"search_context","query":"...","maxTokens":4000}. Results are returned as a ' +
  'completed task whose artifact has a text part (the answer, or a readable summary) and a data part (structured ' +
  'evidence). find_channels and search_context call no model: they return retrieved passages. ask returns an ' +
  'answer in which every sentence cites a passage of this request; when the model is unavailable it returns the ' +
  'passages instead.';

const AUTH =
  'Send a re0 API key as a Bearer token to call as your workspace. find_channels and search_context also work ' +
  'without one, under a low anonymous rate limit and at no cost; with one, each non-empty search costs your ' +
  'workspace one Call. ask needs a key with knowledge:search or knowledge:read and costs 10 Calls per answer ' +
  '(1 if it degrades to passages, nothing if nothing matched), up to 500 answers per workspace per day.';

const CONFIRMATION =
  'Write skills (ingest, refresh, publish; extended card, assets:write scope) never act on their own: the task ' +
  'goes to INPUT_REQUIRED while it waits for the asset owner to confirm in the re0 Dashboard -- a person, not you; ' +
  'there is nothing you can send to confirm it -- and the status message links the pending action. After the ' +
  'confirmation the task returns to WORKING; if the owner declines or 24 hours pass it ends FAILED with the reason. ' +
  'Poll GetTask, subscribe, or register a push notification; set returnImmediately for long tasks.';

function scopeOf(tenant: A2ATenant, own: boolean, subscribes = false): string {
  return tenant.level === 'platform'
    ? 'the free assets of the best-matching public channel (the question is routed to a channel first)'
    : tenant.level === 'user'
      ? own
        ? `all of the assets of re0 user ${tenant.handle}, including those in no channel or a private one (you are calling as that user)`
        : `the free assets in the public channels of re0 user ${tenant.handle}`
      : subscribes
        ? `the free and the subscriber-only (paid) assets in the re0 channel "${tenant.title}" (your workspace subscribes; paid assets stop answering the moment the subscription ends)`
        : `the free assets in the re0 channel "${tenant.title}"`;
}

function skillSearch(tenant: A2ATenant, own = false, subscribes = false) {
  const scope = `Searches ${scopeOf(tenant, own, subscribes)} in one query.`;
  return {
    id: SKILL_SEARCH_CONTEXT,
    name: 'Search context',
    description: `${scope} Returns passages with citations, versions and anchors. ${VERIFIABLE}`,
    tags: ['retrieval', 'citations', 'verifiable', 'context'],
    examples: ['How do I configure retries?', '{"skill":"search_context","query":"rate limits","maxTokens":2000}'],
    inputModes: ['text/plain', 'application/json'],
    outputModes: ['text/plain', 'application/json'],
  };
}

const SKILL_FIND = {
  id: SKILL_FIND_CHANNELS,
  name: 'Find channels',
  description:
    'Finds public re0 channels about a topic and returns each with its page and its own Agent Card address, so you ' +
    'can connect to the channel directly. No model is called and nothing is charged.',
  tags: ['discovery', 'channels', 'directory'],
  examples: ['ethereum client documentation', '{"skill":"find_channels","query":"rust async","limit":5}'],
  inputModes: ['text/plain', 'application/json'],
  outputModes: ['text/plain', 'application/json'],
};

function skillAsk(tenant: A2ATenant, own = false, subscribes = false) {
  return {
    id: SKILL_ASK,
    name: 'Ask',
    description:
      `Answers a question from ${scopeOf(tenant, own, subscribes)}. Every sentence of the answer cites a retrieved passage; the ` +
      `data part lists each citation's chunk_id, asset ID, source URL, section, version and on-chain anchor. ` +
      `Needs an API key; 10 Calls per answer, 500 answers per workspace per day. ${VERIFIABLE}`,
    tags: ['answer', 'citations', 'verifiable'],
    examples: ['How do I rotate an API key?', '{"skill":"ask","query":"What are the rate limits?"}'],
    inputModes: ['text/plain', 'application/json'],
    outputModes: ['text/plain', 'application/json'],
  };
}

function writeSkills(tenant: A2ATenant) {
  const whose = tenant.level === 'user' ? `${tenant.handle}'s workspace` : 'your workspace';
  const pending = 'Waits in INPUT_REQUIRED for the owner to confirm in the Dashboard; needs the assets:write scope.';
  return [
    {
      id: SKILL_INGEST,
      name: 'Ingest',
      description:
        `Turns one source into a new data asset of ${whose} and builds it: a data part ` +
        `{"skill":"ingest","sourceType":"website|github|notion","location":"...","title":"..."}. ` +
        `Costs build Calls and capacity. ${pending} Then SUBMITTED -> WORKING -> COMPLETED or FAILED with the build.`,
      tags: ['write', 'ingest', 'build'],
      examples: ['{"skill":"ingest","sourceType":"github","location":"https://github.com/acme/docs","title":"Acme docs"}'],
      inputModes: ['application/json'],
      outputModes: ['text/plain', 'application/json'],
    },
    {
      id: SKILL_REFRESH,
      name: 'Refresh',
      description:
        `Rebuilds one asset of ${whose} from its source: {"skill":"refresh","assetId":"/websites/acme"}. ` +
        `May cost build Calls. ${pending} CancelTask cancels a build that is still queued.`,
      tags: ['write', 'refresh', 'build'],
      examples: ['{"skill":"refresh","assetId":"/acme/docs"}'],
      inputModes: ['application/json'],
      outputModes: ['text/plain', 'application/json'],
    },
    {
      id: SKILL_PUBLISH,
      name: 'Publish',
      description:
        `Puts one asset of ${whose} into one of its channels, or takes it out (channel null): ` +
        `{"skill":"publish","assetId":"/acme/docs","channel":"acme"}. A public channel makes the asset public. ` +
        `Always needs the owner's confirmation. ${pending}`,
      tags: ['write', 'publish', 'channels'],
      examples: ['{"skill":"publish","assetId":"/acme/docs","channel":"acme"}'],
      inputModes: ['application/json'],
      outputModes: ['text/plain', 'application/json'],
    },
  ];
}

/** Whether the extended card speaks for the caller's own assets on this tenant. */
export function extendedIsOwn(tenant: A2ATenant, workspaceId: string | null): boolean {
  if (!workspaceId) return false;
  return tenant.level === 'platform' || (tenant.level === 'user' && tenant.workspaceId === workspaceId);
}

function quotaLine(quota: CallerQuota): string {
  const mb = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`;
  return (
    `Your workspace: ${quota.planAllowanceRemaining} Calls left in this period's allowance and ` +
    `${quota.addonBalanceRemaining} in call packs; ${mb(quota.usedBytes)} of ${mb(quota.capacityBytes)} capacity used; ` +
    `${quota.answersToday} of ${quota.askDailyAnswers} ask answers used today (UTC), ${quota.askCallsPerAnswer} Calls each.`
  );
}

/** Where the level's own card is served. */
export function cardUrl(origin: string, tenant: Pick<A2ATenant, 'key'>): string {
  return tenant.key ? `${origin}/a2a/${tenant.key}/agent-card.json` : `${origin}/.well-known/agent-card.json`;
}

/** The card as the SDK's core type; `AgentCard.toJSON` gives the v1.0 wire form. */
export function buildAgentCard(facts: CardFacts): AgentCard {
  const { origin, tenant } = facts;
  const endpoint = `${origin}/a2a`;
  const legacyEndpoint = tenant.key ? `${endpoint}/${tenant.key}` : endpoint;

  const name =
    tenant.level === 'platform'
      ? 're0'
      : tenant.level === 'user'
        ? `${tenant.name} on re0`
        : `${tenant.title} (re0 channel)`;
  const lead =
    tenant.level === 'platform'
      ? 're0 is a data asset agent: people turn websites, repositories, documents and pages into versioned data ' +
        'assets and publish them in channels. This agent finds channels by topic and searches their free assets.'
      : tenant.level === 'user'
        ? `The data asset agent of re0 user ${tenant.handle}.`
        : `${tenant.description ?? `A channel of data assets on re0.`}`;

  const own = facts.extended ? extendedIsOwn(tenant, facts.extended.workspaceId) : false;
  const ownUser = own && tenant.level === 'user';
  const subscribes = tenant.level === 'channel' && facts.extended?.subscribes === true;
  const publicSkills =
    tenant.level === 'platform'
      ? [SKILL_FIND, skillSearch(tenant), skillAsk(tenant)]
      : tenant.level === 'user' && !facts.hasPublicChannel && !ownUser
        ? []
        : [skillSearch(tenant, ownUser, subscribes), skillAsk(tenant, ownUser, subscribes)];
  /* The public card never lists a write skill (proposal 7.2). */
  const skills = own ? [...publicSkills, ...writeSkills(tenant)] : publicSkills;
  const extensions = facts.extended
    ? [
        {
          uri: QUOTA_EXTENSION_URI,
          description: "The calling workspace's remaining Calls, capacity and daily ask answers, as of this card.",
          required: false,
          params: { ...facts.extended.quota },
        },
      ]
    : [];

  return AgentCard.fromJSON({
    name,
    description: [lead, VERIFIABLE, HOW_TO_CALL, AUTH, CONFIRMATION, ...(facts.extended ? [quotaLine(facts.extended.quota)] : [])].join(' '),
    supportedInterfaces: [
      { url: endpoint, protocolBinding: 'JSONRPC', tenant: tenant.key, protocolVersion: A2A_PROTOCOL_VERSION },
      { url: endpoint, protocolBinding: 'HTTP+JSON', tenant: tenant.key, protocolVersion: A2A_PROTOCOL_VERSION },
      { url: legacyEndpoint, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: A2A_LEGACY_VERSION },
    ],
    provider: { organization: 're0', url: origin },
    version: AGENT_CARD_VERSION,
    documentationUrl: `${origin}/#agents`,
    iconUrl: `${origin}/icon.svg`,
    capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: true, extensions },
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: 'Bearer',
          bearerFormat: 're0 API key',
          description:
            'A re0 API key. knowledge:search or knowledge:read for the retrieval skills and ask (optional for ' +
            'find_channels and search_context); assets:write for ingest, refresh and publish.',
        },
      },
    },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills,
  });
}

/** The v1.0 wire form. */
export function agentCardJson(card: AgentCard): unknown {
  return AgentCard.toJSON(card);
}

/**
 * The v0.3 shape of a card, for a caller that sends no `A2A-Version` (which
 * the specification reads as 0.3), with the v1.0 interfaces embedded as
 * `supportedInterfaces` so a v1.0 client reading the same document still
 * finds them.
 *
 * The SDK has this translation (`toCompatAgentCard`) but exports it only
 * inside its Express card router, so this follows it field by field: the
 * first 0.3 interface is the card's `url` and `preferredTransport`, the
 * others are `additionalInterfaces`, the Bearer scheme becomes the OpenAPI
 * `http` form, `protocolVersion` moves to the card.
 */
export function legacyAgentCardJson(card: AgentCard): Record<string, unknown> {
  const legacy = card.supportedInterfaces.filter((intf) => !intf.protocolVersion || intf.protocolVersion.startsWith('0.'));
  const primary = legacy[0];
  if (!primary) throw new Error('the card declares no v0.3 interface');
  const optional = <T>(value: T | undefined | '') => (value === undefined || value === '' ? undefined : value);
  const securitySchemes = Object.fromEntries(
    Object.entries(card.securitySchemes).flatMap(([name, scheme]) =>
      scheme.scheme?.$case === 'httpAuthSecurityScheme'
        ? [[name, { type: 'http', scheme: scheme.scheme.value.scheme, bearerFormat: optional(scheme.scheme.value.bearerFormat), description: optional(scheme.scheme.value.description) }]]
        : [],
    ),
  );
  const wire = AgentCard.toJSON(card) as { supportedInterfaces?: unknown[] };
  return {
    name: card.name,
    description: card.description,
    version: card.version,
    url: primary.url,
    preferredTransport: primary.protocolBinding,
    protocolVersion: primary.protocolVersion || A2A_LEGACY_VERSION,
    capabilities: {
      ...(card.capabilities?.streaming !== undefined ? { streaming: card.capabilities.streaming } : {}),
      ...(card.capabilities?.pushNotifications !== undefined ? { pushNotifications: card.capabilities.pushNotifications } : {}),
    },
    defaultInputModes: [...card.defaultInputModes],
    defaultOutputModes: [...card.defaultOutputModes],
    skills: card.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: [...skill.tags],
      ...(skill.examples.length > 0 ? { examples: [...skill.examples] } : {}),
      ...(skill.inputModes.length > 0 ? { inputModes: [...skill.inputModes] } : {}),
      ...(skill.outputModes.length > 0 ? { outputModes: [...skill.outputModes] } : {}),
    })),
    ...(legacy.length > 1
      ? { additionalInterfaces: legacy.slice(1).map((intf) => ({ url: intf.url, transport: intf.protocolBinding })) }
      : {}),
    ...(card.provider ? { provider: { url: card.provider.url, organization: card.provider.organization } } : {}),
    ...(optional(card.documentationUrl) ? { documentationUrl: card.documentationUrl } : {}),
    ...(optional(card.iconUrl) ? { iconUrl: card.iconUrl } : {}),
    ...(card.capabilities?.extendedAgentCard !== undefined
      ? { supportsAuthenticatedExtendedCard: card.capabilities.extendedAgentCard }
      : {}),
    ...(Object.keys(securitySchemes).length > 0 ? { securitySchemes } : {}),
    supportedInterfaces: wire.supportedInterfaces ?? [],
  };
}
