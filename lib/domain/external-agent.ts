/**
 * External A2A Agents a workspace delegates to (agent-first-proposal.md 7.9).
 * Pure: no I/O.
 *
 * re0 is an A2A client here. What a user registers is a stranger's Agent
 * Card, and what it points at is a server re0 will send the user's words
 * and credential to, so most of this file is about what is accepted: which
 * card URLs, which interfaces (JSON-RPC and HTTP+JSON, A2A 1.0 or 0.3 -- no
 * gRPC), which credential kinds and how each is put on a request. The size
 * and time limits on everything that comes back are here too, because what
 * comes back is untrusted input that is stored and shown.
 */

/** Proposal 7.9: as many as API keys (8.1). */
export const MAX_EXTERNAL_AGENTS = 20;

export const CARD_MAX_BYTES = 256 * 1024;
export const CARD_TIMEOUT_MS = 10_000;
/** One outbound A2A request: SendMessage, GetTask, CancelTask. */
export const SEND_TIMEOUT_MS = 20_000;
export const RESPONSE_MAX_BYTES = 1024 * 1024;
/** What is kept of an external Agent's output (status text plus artifacts), in characters. */
export const OUTPUT_MAX_CHARS = 32_000;
/** The sub-task text the owner confirms and re0 sends. */
export const MESSAGE_MAX_CHARS = 4_000;
/** Proposal 10: bodies of A2A tasks, inbound and outbound, are kept 30 days. */
export const BODY_RETENTION_DAYS = 30;

export const CARD_PATH = '/.well-known/agent-card.json';

export type EndpointBinding = 'JSONRPC' | 'HTTP+JSON';
export type EndpointVersion = '1.0' | '0.3';

/** One interface of the card that re0 can talk to. */
export interface AgentEndpoint {
  url: string;
  binding: EndpointBinding;
  /** As the card wrote it; `endpointVersion` says which family it is. */
  protocolVersion: string;
  tenant: string;
}

export interface AgentSkillSnapshot {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export type CredentialKind = 'bearer' | 'api_key';

export type ExternalAgentStatus = 'active' | 'disabled';

/** Why a card or an endpoint was refused; the Dashboard words the code. */
export class ExternalAgentRefused extends Error {
  constructor(
    readonly code:
      | 'invalid_url'
      | 'forbidden_address'
      | 'unreachable'
      | 'redirected'
      | 'too_large'
      | 'not_a_card'
      | 'no_usable_interface'
      | 'limit_reached'
      | 'duplicate'
      | 'not_found'
      | 'disabled'
      | 'credential_kind'
      | 'credential_invalid'
      | 'key_not_configured',
    message: string,
  ) {
    super(message);
    this.name = 'ExternalAgentRefused';
  }
}

/**
 * The card URL a user typed, as re0 will fetch it: https only, no
 * credentials or fragment, and a bare origin means the well-known path.
 * Returns null for anything that is not such a URL; the address checks come
 * after (callback-url.ts).
 */
export function normalizeCardUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 2_000) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  url.hash = '';
  if (url.pathname === '' || url.pathname === '/') url.pathname = CARD_PATH;
  return url.toString();
}

export function endpointVersion(protocolVersion: string): EndpointVersion | null {
  const value = protocolVersion.trim();
  if (value === '' || value === '1.0' || value.startsWith('1.0.')) return '1.0';
  if (value === '0.3' || value.startsWith('0.3.')) return '0.3';
  return null;
}

/**
 * The interfaces re0 can use, in the order it prefers them: A2A 1.0 before
 * 0.3, JSON-RPC before HTTP+JSON, then the card's own order. gRPC and
 * anything newer or older is left out (proposal 7.3, 7.9).
 */
export function usableEndpoints(
  interfaces: readonly { url?: unknown; protocolBinding?: unknown; protocolVersion?: unknown; tenant?: unknown }[],
): AgentEndpoint[] {
  const out: (AgentEndpoint & { rank: number })[] = [];
  interfaces.forEach((entry, order) => {
    if (typeof entry.url !== 'string') return;
    const binding = String(entry.protocolBinding ?? '').toUpperCase();
    if (binding !== 'JSONRPC' && binding !== 'HTTP+JSON') return;
    const protocolVersion = typeof entry.protocolVersion === 'string' ? entry.protocolVersion : '';
    const family = endpointVersion(protocolVersion);
    if (!family) return;
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      return;
    }
    if (url.protocol !== 'https:' || url.username || url.password) return;
    out.push({
      url: url.toString(),
      binding,
      protocolVersion: protocolVersion || '1.0',
      tenant: typeof entry.tenant === 'string' ? entry.tenant : '',
      rank: (family === '1.0' ? 0 : 2) + (binding === 'JSONRPC' ? 0 : 1) + order / 1_000,
    });
  });
  return out.sort((a, b) => a.rank - b.rank).map(({ rank: _rank, ...endpoint }) => endpoint);
}

/** A security scheme as the SDK's normalized card holds it. */
export type SchemeSnapshot =
  | { kind: 'bearer' }
  | { kind: 'api_key'; header: string | null }
  | { kind: 'unsupported'; type: string };

/** The card's `securitySchemes`, reduced to what re0 can do with each. */
export function schemeSnapshots(
  schemes: Record<string, { scheme?: { $case?: string; value?: Record<string, unknown> } } | undefined>,
): Record<string, SchemeSnapshot> {
  const out: Record<string, SchemeSnapshot> = {};
  for (const [name, entry] of Object.entries(schemes ?? {})) {
    const scheme = entry?.scheme;
    if (scheme?.$case === 'httpAuthSecurityScheme' && String(scheme.value?.scheme ?? '').toLowerCase() === 'bearer') {
      out[name] = { kind: 'bearer' };
    } else if (scheme?.$case === 'apiKeySecurityScheme') {
      const location = String(scheme.value?.location ?? '').toLowerCase();
      const header = typeof scheme.value?.name === 'string' ? scheme.value.name : '';
      out[name] =
        location === 'header' && HEADER_NAME.test(header)
          ? { kind: 'api_key', header }
          : { kind: 'unsupported', type: `apiKey in ${location || 'unknown'}` };
    } else {
      out[name] = { kind: 'unsupported', type: scheme?.$case ?? 'unknown' };
    }
  }
  return out;
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const DEFAULT_API_KEY_HEADER = 'X-API-Key';
/** Headers a credential may never be put in: they are the transport's or the protocol's. */
const RESERVED_HEADERS = new Set(['host', 'content-type', 'content-length', 'a2a-version', 'a2a-extensions', 'cookie', 'connection']);

/** Whether the card asks for credentials at all: any security requirement, or any declared scheme. */
export function cardRequiresCredential(requirements: readonly unknown[], schemes: Record<string, SchemeSnapshot>): boolean {
  return requirements.length > 0 || Object.keys(schemes).length > 0;
}

/**
 * The request header a credential goes in. A bearer token is always
 * `Authorization`; an API key uses the header the card's apiKey scheme
 * names, or `X-API-Key` when the card names none.
 */
export function credentialHeader(kind: CredentialKind, schemes: Record<string, SchemeSnapshot>): string {
  if (kind === 'bearer') return 'Authorization';
  for (const scheme of Object.values(schemes)) {
    if (scheme.kind === 'api_key' && scheme.header && !RESERVED_HEADERS.has(scheme.header.toLowerCase())) {
      return scheme.header;
    }
  }
  return DEFAULT_API_KEY_HEADER;
}

/** The header value: `Bearer <token>` or the key as given. */
export function credentialValue(kind: CredentialKind, secret: string): string {
  return kind === 'bearer' ? `Bearer ${secret}` : secret;
}

/**
 * What a user may save: printable ASCII, no whitespace inside, 8 to 4,096
 * characters. A header value with a newline in it is a header injection,
 * not a credential.
 */
export function isCredentialShaped(secret: string): boolean {
  return /^[\x21-\x7e]{8,4096}$/.test(secret);
}

/** The only part of a saved credential ever shown again: its last four characters, if it is long enough to spare them. */
export function maskedSuffix(secret: string): string | null {
  return secret.length >= 12 ? secret.slice(-4) : null;
}

/** A2A 1.0 task states as the SDK names them, plus re0's own for a reply that was a message. */
export const TERMINAL_REMOTE_STATES: ReadonlySet<string> = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
  /* The external Agent answered with a Message: nothing more will happen. */
  'MESSAGE',
  /* re0 could not deliver the SendMessage; there is no remote task. */
  'SEND_FAILED',
]);

export function isTerminalRemoteState(state: string): boolean {
  return TERMINAL_REMOTE_STATES.has(state);
}

/** Cuts untrusted text to what is kept, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
