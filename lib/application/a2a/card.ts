/**
 * Agent Cards, one generator for three levels (agent-first-proposal.md 7.1,
 * 7.2, 7.3, 7.5):
 *
 * | level    | served at                                   | tenant            | P1 skills                       |
 * | platform | /.well-known/agent-card.json                | ''                | find_channels, search_context   |
 * | user     | /a2a/users/{handle}/agent-card.json         | users/{handle}    | search_context (if any public channel) |
 * | channel  | /a2a/channels/{slug}/agent-card.json        | channels/{slug}   | search_context                  |
 *
 * Every card declares the one A2A server twice, JSON-RPC and HTTP+JSON, at
 * protocol 1.0 with the level's tenant; and once more per binding at 0.3,
 * the SDK's compatibility mode, where the tenant rides in the URL path
 * because v0.3 clients have no tenant field. Auth is an optional Bearer: the
 * API key's workspace is the caller, and without one the public skills run
 * under the anonymous rate limit (proposal 7.4). The extended card and the
 * write skills are P2.
 *
 * Nothing internal appears here -- no service address, no credential
 * (A2A specification 13.3) -- and the description says what makes re0's
 * results different: every passage carries its asset, version and that
 * version's on-chain anchor, checkable with the public Verifier without
 * calling re0 again.
 */
import { AgentCard } from '@a2a-js/sdk';
import type { A2ATenant } from './tenant';

export const A2A_PROTOCOL_VERSION = '1.0';
export const A2A_LEGACY_VERSION = '0.3';
export const AGENT_CARD_VERSION = '1.0.0';

export const SKILL_FIND_CHANNELS = 'find_channels';
export const SKILL_SEARCH_CONTEXT = 'search_context';
export type A2ASkill = typeof SKILL_FIND_CHANNELS | typeof SKILL_SEARCH_CONTEXT;

export interface CardFacts {
  /** The deployment's origin, `https://re0.io` in production. */
  origin: string;
  tenant: A2ATenant;
  /** For a user card: whether the user has any public channel, without which it has no search skill. */
  hasPublicChannel?: boolean;
}

const VERIFIABLE =
  'Every passage comes back with its source URL, its asset ID, the immutable version it was read from and that ' +
  "version's on-chain anchor, so a caller can verify the version independently with the public Verifier, without " +
  'calling re0 again.';

const HOW_TO_CALL =
  'Send a text message with the question. To pick a skill explicitly, set message metadata `skill`, or include a ' +
  'data part such as {"skill":"search_context","query":"...","maxTokens":4000}. Results are returned as a ' +
  'completed task whose artifact has a text part (readable summary) and a data part (structured evidence). ' +
  'No model is called: results are retrieved passages, not generated answers.';

const AUTH =
  'Authentication is optional: send a re0 API key as a Bearer token to call as your workspace (each non-empty ' +
  'search costs your workspace one Call); without one, public skills run under a low anonymous rate limit and ' +
  'cost nothing.';

function skillSearch(tenant: A2ATenant) {
  const scope =
    tenant.level === 'platform'
      ? 'Routes the question to the best-matching public channel, then searches the free assets in it.'
      : tenant.level === 'user'
        ? `Searches the free assets in the public channels of re0 user ${tenant.handle}; called with that user's own API key, all of their assets.`
        : `Searches the free assets in the re0 channel "${tenant.title}" in one query.`;
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

  const skills =
    tenant.level === 'platform'
      ? [SKILL_FIND, skillSearch(tenant)]
      : tenant.level === 'user' && !facts.hasPublicChannel
        ? []
        : [skillSearch(tenant)];

  return AgentCard.fromJSON({
    name,
    description: `${lead} ${VERIFIABLE} ${HOW_TO_CALL} ${AUTH}`,
    supportedInterfaces: [
      { url: endpoint, protocolBinding: 'JSONRPC', tenant: tenant.key, protocolVersion: A2A_PROTOCOL_VERSION },
      { url: endpoint, protocolBinding: 'HTTP+JSON', tenant: tenant.key, protocolVersion: A2A_PROTOCOL_VERSION },
      { url: legacyEndpoint, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: A2A_LEGACY_VERSION },
      { url: legacyEndpoint, protocolBinding: 'HTTP+JSON', tenant: '', protocolVersion: A2A_LEGACY_VERSION },
    ],
    provider: { organization: 're0', url: origin },
    version: AGENT_CARD_VERSION,
    documentationUrl: `${origin}/#agents`,
    iconUrl: `${origin}/icon.svg`,
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: 'Bearer',
          bearerFormat: 're0 API key',
          description: 'A re0 API key with the knowledge:search or knowledge:read scope. Optional for public skills.',
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
