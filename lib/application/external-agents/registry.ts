/**
 * The external Agent registry (agent-first-proposal.md 7.9, prerequisites 1
 * and 2): a workspace's list of A2A Agents re0 may delegate to, each with at
 * most one sealed credential.
 *
 * Registering fetches the Agent Card through the outbound checks
 * (transport.ts), normalizes it with the SDK's resolver -- v0.3 cards
 * included, as P1's server accepts them -- and keeps a snapshot of what re0
 * can use: JSON-RPC and HTTP+JSON interfaces, every one of whose URLs passes
 * the same address checks, the skills, and the security schemes reduced to
 * the two re0 can send (a bearer token, an API key in a header).
 *
 * A credential is sealed the moment it arrives and opened only by
 * `openCredentialFor`, which the delegation send calls; no view here carries
 * more than its kind and last four characters. Every write is an owner's or
 * admin's, from a Dashboard session -- the Agent has no tool that reaches
 * this module.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { AgentCard } from '@a2a-js/sdk';
import { DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import { AppError } from '@/contracts/errors';
import { canonicalJson } from '@/lib/domain/agent-action';
import {
  CARD_MAX_BYTES,
  CARD_TIMEOUT_MS,
  cardRequiresCredential,
  clip,
  credentialHeader,
  ExternalAgentRefused,
  isCredentialShaped,
  maskedSuffix,
  MAX_EXTERNAL_AGENTS,
  normalizeCardUrl,
  schemeSnapshots,
  usableEndpoints,
  type AgentEndpoint,
  type AgentSkillSnapshot,
  type CredentialKind,
  type ExternalAgentStatus,
  type SchemeSnapshot,
} from '@/lib/domain/external-agent';
import { uuidv7 } from '@/lib/domain/id';
import { canManageAssets, type WorkspaceRole } from '@/lib/application/assets/delete';
import { isCredentialKeyConfigured, openCredential, sealCredential } from '@/lib/infrastructure/crypto/credentials';
import { sha256 } from '@/lib/infrastructure/crypto/tokens';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { assertAgentAddress, guardedFetch } from './transport';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SKILLS = 50;

/** What the Dashboard and the planner see of a registration. Never the credential. */
export interface ExternalAgentView {
  id: string;
  cardUrl: string;
  name: string;
  description: string;
  providerName: string | null;
  version: string | null;
  endpoints: AgentEndpoint[];
  skills: AgentSkillSnapshot[];
  schemes: Record<string, SchemeSnapshot>;
  requiresCredential: boolean;
  status: ExternalAgentStatus;
  credential: { id: string; kind: CredentialKind; suffix: string | null; version: number; header: string; updatedAt: string } | null;
  fetchedAt: string;
  createdAt: string;
}

type AgentRow = typeof schema.externalAgent.$inferSelect;
/** A registration without its card snapshot, which only building a client needs. */
type AgentListRow = Omit<AgentRow, 'card'>;

/** Every column but `card` (up to 256 KB): what views and lookups read. */
const AGENT_COLUMNS = {
  id: schema.externalAgent.id,
  workspaceId: schema.externalAgent.workspaceId,
  createdBy: schema.externalAgent.createdBy,
  cardUrl: schema.externalAgent.cardUrl,
  name: schema.externalAgent.name,
  description: schema.externalAgent.description,
  providerName: schema.externalAgent.providerName,
  version: schema.externalAgent.version,
  endpoints: schema.externalAgent.endpoints,
  skills: schema.externalAgent.skills,
  securitySchemes: schema.externalAgent.securitySchemes,
  securityRequirements: schema.externalAgent.securityRequirements,
  cardDigest: schema.externalAgent.cardDigest,
  status: schema.externalAgent.status,
  fetchedAt: schema.externalAgent.fetchedAt,
  createdAt: schema.externalAgent.createdAt,
  updatedAt: schema.externalAgent.updatedAt,
};
type CredentialRow = Pick<typeof schema.externalAgentCredential.$inferSelect, 'id' | 'kind' | 'suffix' | 'version' | 'updatedAt'>;

/** The credential columns a view may read: everything but `sealed`. */
const CREDENTIAL_COLUMNS = {
  agentId: schema.externalAgentCredential.agentId,
  id: schema.externalAgentCredential.id,
  kind: schema.externalAgentCredential.kind,
  suffix: schema.externalAgentCredential.suffix,
  version: schema.externalAgentCredential.version,
  updatedAt: schema.externalAgentCredential.updatedAt,
};

function view(row: AgentListRow, credential: CredentialRow | null): ExternalAgentView {
  const schemes = row.securitySchemes as Record<string, SchemeSnapshot>;
  return {
    id: row.id,
    cardUrl: row.cardUrl,
    name: row.name,
    description: row.description,
    providerName: row.providerName ?? null,
    version: row.version ?? null,
    endpoints: row.endpoints as unknown as AgentEndpoint[],
    skills: row.skills as unknown as AgentSkillSnapshot[],
    schemes,
    requiresCredential: cardRequiresCredential(row.securityRequirements as string[][]),
    status: row.status,
    credential: credential
      ? {
          id: credential.id,
          kind: credential.kind,
          suffix: credential.suffix ?? null,
          version: credential.version,
          header: credentialHeader(credential.kind, schemes),
          updatedAt: credential.updatedAt.toISOString(),
        }
      : null,
    fetchedAt: row.fetchedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function assertManager(role: WorkspaceRole): void {
  if (!canManageAssets(role)) {
    throw new AppError('access_denied', 'only a workspace owner or admin can manage external agents');
  }
}

/* ---------------------------------------------------------------- the card */

export interface FetchedCard {
  cardUrl: string;
  name: string;
  description: string;
  providerName: string | null;
  version: string | null;
  endpoints: AgentEndpoint[];
  skills: AgentSkillSnapshot[];
  schemes: Record<string, SchemeSnapshot>;
  requirements: string[][];
  json: Record<string, unknown>;
  digest: string;
}

const resolver = new DefaultAgentCardResolver({ legacyCompat: { enabled: true } });

/**
 * Fetches and checks one Agent Card. Refuses (`ExternalAgentRefused`) a URL
 * that is not https, an address that is private, loopback or link-local, a
 * redirect, an answer over 256 KB, anything that is not a card, and a card
 * with no interface re0 can use.
 */
export async function fetchAgentCard(raw: string): Promise<FetchedCard> {
  const cardUrl = normalizeCardUrl(raw);
  if (!cardUrl) throw new ExternalAgentRefused('invalid_url', 'an Agent Card URL is an https address');
  const response = await guardedFetch({ timeoutMs: CARD_TIMEOUT_MS, maxBytes: CARD_MAX_BYTES })(cardUrl, {
    headers: { accept: 'application/json', 'A2A-Version': '1.0' },
  });
  if (!response.ok) throw new ExternalAgentRefused('unreachable', `the card URL answered ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ExternalAgentRefused('not_a_card', 'the card URL did not return JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ExternalAgentRefused('not_a_card', 'the card URL did not return an Agent Card');
  }
  let card: AgentCard;
  try {
    card = resolver.normalizeAgentCard(payload);
    if (typeof card.name !== 'string' || !card.name.trim() || !Array.isArray(card.supportedInterfaces)) throw new Error('shape');
  } catch {
    throw new ExternalAgentRefused('not_a_card', 'the card URL did not return an Agent Card');
  }
  const endpoints = usableEndpoints(card.supportedInterfaces);
  if (endpoints.length === 0) {
    throw new ExternalAgentRefused('no_usable_interface', 'the card lists no JSON-RPC or HTTP+JSON interface on A2A 1.0 or 0.3');
  }
  /* Every interface is an address re0 will send credentials to: each passes the same checks now. */
  for (const endpoint of endpoints) await assertAgentAddress(endpoint.url);

  const json = AgentCard.toJSON(card) as Record<string, unknown>;
  return {
    cardUrl,
    name: clip(card.name.trim(), 120),
    description: clip((card.description ?? '').trim(), 1_000),
    providerName: card.provider?.organization ? clip(card.provider.organization, 120) : null,
    version: card.version ? clip(card.version, 40) : null,
    endpoints,
    skills: (card.skills ?? []).slice(0, MAX_SKILLS).map((skill) => ({
      id: clip(String(skill.id ?? ''), 80),
      name: clip(String(skill.name ?? skill.id ?? ''), 120),
      description: clip(String(skill.description ?? ''), 500),
      tags: (skill.tags ?? []).slice(0, 10).map((tag) => clip(String(tag), 40)),
    })),
    schemes: schemeSnapshots(card.securitySchemes as Parameters<typeof schemeSnapshots>[0]),
    requirements: (card.securityRequirements ?? []).map((requirement) => Object.keys(requirement.schemes ?? {})),
    json,
    digest: await sha256(canonicalJson(json)),
  };
}

/* ------------------------------------------------------------------ writes */

export async function registerExternalAgent(input: {
  workspaceId: string;
  role: WorkspaceRole;
  userId: string;
  cardUrl: string;
}): Promise<ExternalAgentView> {
  assertManager(input.role);
  const cardUrl = normalizeCardUrl(input.cardUrl);
  if (!cardUrl) throw new ExternalAgentRefused('invalid_url', 'an Agent Card URL is an https address');
  const [{ n } = { n: 0 }] = await db()
    .select({ n: count() })
    .from(schema.externalAgent)
    .where(eq(schema.externalAgent.workspaceId, input.workspaceId));
  if (Number(n) >= MAX_EXTERNAL_AGENTS) {
    throw new ExternalAgentRefused('limit_reached', `a workspace registers at most ${MAX_EXTERNAL_AGENTS} external agents`);
  }
  const card = await fetchAgentCard(cardUrl);
  const now = new Date();
  const [row] = await db()
    .insert(schema.externalAgent)
    .values({
      id: uuidv7(),
      workspaceId: input.workspaceId,
      createdBy: input.userId,
      ...cardColumns(card),
      fetchedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new ExternalAgentRefused('duplicate', 'this Agent Card is already registered');
  return view(row, null);
}

function cardColumns(card: FetchedCard) {
  return {
    cardUrl: card.cardUrl,
    name: card.name,
    description: card.description,
    providerName: card.providerName,
    version: card.version,
    endpoints: card.endpoints as unknown as Record<string, unknown>[],
    skills: card.skills as unknown as Record<string, unknown>[],
    securitySchemes: card.schemes as Record<string, unknown>,
    securityRequirements: card.requirements,
    card: card.json,
    cardDigest: card.digest,
  };
}

/** Fetches the card again, through the same checks, and replaces the snapshot. */
export async function refreshExternalAgent(input: { workspaceId: string; role: WorkspaceRole; agentId: string }): Promise<ExternalAgentView> {
  assertManager(input.role);
  const row = await ownedRow(input.workspaceId, input.agentId);
  const card = await fetchAgentCard(row.cardUrl);
  const now = new Date();
  const [updated] = await db()
    .update(schema.externalAgent)
    .set({ ...cardColumns(card), cardUrl: row.cardUrl, fetchedAt: now, updatedAt: now })
    .where(eq(schema.externalAgent.id, row.id))
    .returning();
  return view(updated!, await credentialRow(row.id));
}

export async function setExternalAgentStatus(input: {
  workspaceId: string;
  role: WorkspaceRole;
  agentId: string;
  status: ExternalAgentStatus;
}): Promise<ExternalAgentView> {
  assertManager(input.role);
  const row = await ownedRow(input.workspaceId, input.agentId);
  const [updated] = await db()
    .update(schema.externalAgent)
    .set({ status: input.status === 'disabled' ? 'disabled' : 'active', updatedAt: new Date() })
    .where(eq(schema.externalAgent.id, row.id))
    .returning();
  return view(updated!, await credentialRow(row.id));
}

/** Removes the registration and its credential; past delegations keep their record. */
export async function removeExternalAgent(input: { workspaceId: string; role: WorkspaceRole; agentId: string }): Promise<void> {
  assertManager(input.role);
  const row = await ownedRow(input.workspaceId, input.agentId);
  await db().delete(schema.externalAgent).where(eq(schema.externalAgent.id, row.id));
}

/**
 * Saves or rotates the agent's credential: sealed before it touches the
 * database, version up by one on a rotation. Returns the masked view only.
 */
export async function saveAgentCredential(input: {
  workspaceId: string;
  role: WorkspaceRole;
  userId: string;
  agentId: string;
  kind: CredentialKind;
  secret: string;
}): Promise<ExternalAgentView> {
  assertManager(input.role);
  if (input.kind !== 'bearer' && input.kind !== 'api_key') {
    throw new ExternalAgentRefused('credential_kind', 'a credential is a bearer token or an API key');
  }
  const secret = input.secret.trim();
  if (!isCredentialShaped(secret)) {
    throw new ExternalAgentRefused('credential_invalid', 'a credential is 8 to 4096 printable characters with no spaces');
  }
  if (!isCredentialKeyConfigured()) {
    throw new ExternalAgentRefused('key_not_configured', 'credentials cannot be sealed until CREDENTIAL_ENCRYPTION_KEY is set');
  }
  const row = await ownedRow(input.workspaceId, input.agentId);
  const sealed = await sealCredential(secret, 'agent');
  const now = new Date();
  await db()
    .insert(schema.externalAgentCredential)
    .values({
      agentId: row.id,
      id: randomUUID(),
      kind: input.kind,
      sealed,
      suffix: maskedSuffix(secret),
      version: 1,
      updatedBy: input.userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.externalAgentCredential.agentId,
      set: {
        kind: input.kind,
        sealed,
        suffix: maskedSuffix(secret),
        version: sql`${schema.externalAgentCredential.version} + 1`,
        updatedBy: input.userId,
        updatedAt: now,
      },
    });
  return view(row, await credentialRow(row.id));
}

export async function deleteAgentCredential(input: { workspaceId: string; role: WorkspaceRole; agentId: string }): Promise<ExternalAgentView> {
  assertManager(input.role);
  const row = await ownedRow(input.workspaceId, input.agentId);
  await db().delete(schema.externalAgentCredential).where(eq(schema.externalAgentCredential.agentId, row.id));
  return view(row, null);
}

/* ------------------------------------------------------------------- reads */

export async function listExternalAgents(workspaceId: string): Promise<ExternalAgentView[]> {
  const rows = await db()
    .select({ agent: AGENT_COLUMNS, credential: CREDENTIAL_COLUMNS })
    .from(schema.externalAgent)
    .leftJoin(schema.externalAgentCredential, eq(schema.externalAgentCredential.agentId, schema.externalAgent.id))
    .where(eq(schema.externalAgent.workspaceId, workspaceId))
    .orderBy(asc(schema.externalAgent.createdAt));
  return rows.map(({ agent, credential }) => view(agent, credential?.id ? credential : null));
}

export async function externalAgentById(workspaceId: string, agentId: string): Promise<ExternalAgentView | null> {
  if (!UUID.test(agentId)) return null;
  const [row] = await db()
    .select(AGENT_COLUMNS)
    .from(schema.externalAgent)
    .where(and(eq(schema.externalAgent.id, agentId), eq(schema.externalAgent.workspaceId, workspaceId)))
    .limit(1);
  return row ? view(row, await credentialRow(row.id)) : null;
}

/**
 * An agent of this workspace by id or by name (case-insensitive), as the
 * planner names it. Names need not be unique: an active one wins over a
 * disabled one of the same name.
 */
export async function findExternalAgent(workspaceId: string, ref: string): Promise<ExternalAgentView | null> {
  const value = ref.trim();
  if (!value) return null;
  if (UUID.test(value)) return externalAgentById(workspaceId, value);
  const lower = value.toLowerCase();
  const named = (await listExternalAgents(workspaceId)).filter((agent) => agent.name.toLowerCase() === lower);
  return named.find((agent) => agent.status === 'active') ?? named[0] ?? null;
}

/**
 * The stored credential in the clear, for the one request about to be
 * sent. Only the delegation send calls this, and only with the id and
 * version a confirmed action names: a rotated or deleted credential yields
 * null, which the caller treats as stale.
 */
export async function openCredentialFor(agentId: string, expected: { id: string; version: number }): Promise<string | null> {
  const [row] = await db()
    .select({ id: schema.externalAgentCredential.id, version: schema.externalAgentCredential.version, sealed: schema.externalAgentCredential.sealed })
    .from(schema.externalAgentCredential)
    .where(eq(schema.externalAgentCredential.agentId, agentId))
    .limit(1);
  if (!row || row.id !== expected.id || row.version !== expected.version) return null;
  return openCredential(row.sealed, 'agent');
}

/** The stored card, for building a client. */
export async function storedCard(workspaceId: string, agentId: string): Promise<{ row: AgentRow; card: AgentCard } | null> {
  if (!UUID.test(agentId)) return null;
  const [row] = await db()
    .select()
    .from(schema.externalAgent)
    .where(and(eq(schema.externalAgent.id, agentId), eq(schema.externalAgent.workspaceId, workspaceId)))
    .limit(1);
  if (!row) return null;
  return { row, card: resolver.normalizeAgentCard(row.card) };
}

async function ownedRow(workspaceId: string, agentId: string): Promise<AgentListRow> {
  if (!UUID.test(agentId)) throw new ExternalAgentRefused('not_found', 'no such external agent');
  const [row] = await db()
    .select(AGENT_COLUMNS)
    .from(schema.externalAgent)
    .where(and(eq(schema.externalAgent.id, agentId), eq(schema.externalAgent.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new ExternalAgentRefused('not_found', 'no such external agent');
  return row;
}

async function credentialRow(agentId: string): Promise<CredentialRow | null> {
  const [row] = await db()
    .select(CREDENTIAL_COLUMNS)
    .from(schema.externalAgentCredential)
    .where(eq(schema.externalAgentCredential.agentId, agentId))
    .limit(1);
  return row ?? null;
}
