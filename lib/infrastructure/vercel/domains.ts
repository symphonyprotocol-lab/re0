/**
 * The deployment's own Vercel project, through the REST API: adding a
 * customer's subdomain to it, asking Vercel to verify it, reading whether
 * its DNS is configured, and removing it. Nothing else of the API is used.
 *
 * Configuration is three environment variables; with any of them missing
 * the feature is simply not offered (`isVercelDomainsConfigured`). Every
 * failure is `provider_unavailable` with Vercel's message and never the
 * token.
 */
import { AppError } from '@/contracts/errors';

const API = 'https://api.vercel.com';
const TIMEOUT_MS = 15_000;

export interface VercelDomainVerification {
  type: string;
  domain: string;
  value: string;
  reason?: string;
}

export interface VercelDomainState {
  verified: boolean;
  verification: VercelDomainVerification[];
  /** The host is attached to a project in another account; Vercel will not take it until released there. */
  inUseElsewhere?: boolean;
}

function settings(): { token: string; projectId: string; teamId: string | null } | null {
  const token = process.env.VERCEL_API_TOKEN?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (!token || !projectId) return null;
  return { token, projectId, teamId: process.env.VERCEL_TEAM_ID?.trim() || null };
}

export function isVercelDomainsConfigured(): boolean {
  return settings() !== null;
}

function requireSettings(): { token: string; projectId: string; teamId: string | null } {
  const config = settings();
  if (!config) throw new AppError('provider_unavailable', 'custom domains are not configured on this deployment');
  return config;
}

async function call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const config = requireSettings();
  const url = new URL(`${API}${path}`);
  if (config.teamId) url.searchParams.set('teamId', config.teamId);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError('provider_unavailable', `Vercel did not answer: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    /* an empty body on 204 */
  }
  return { status: response.status, json };
}

function refusal(json: Record<string, unknown>, fallback: string): AppError {
  const error = json.error as { message?: unknown; code?: unknown } | undefined;
  const message = typeof error?.message === 'string' ? error.message : fallback;
  return new AppError('provider_unavailable', `Vercel: ${message}`);
}

function stateOf(json: Record<string, unknown>): VercelDomainState {
  const list = Array.isArray(json.verification) ? json.verification : [];
  return {
    verified: json.verified === true,
    verification: list
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        type: String(item.type ?? ''),
        domain: String(item.domain ?? ''),
        value: String(item.value ?? ''),
        ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
      })),
  };
}

const project = () => encodeURIComponent(requireSettings().projectId);

/**
 * Add the host to the project. A host already on this project is read back
 * rather than refused; one another account holds is reported as such, so
 * the owner is told to release it there rather than shown a raw refusal.
 */
export async function addProjectDomain(host: string): Promise<VercelDomainState> {
  const { status, json } = await call('POST', `/v10/projects/${project()}/domains`, { name: host });
  const code = String((json.error as { code?: unknown })?.code ?? '');
  if (status === 409 || status === 403 || code === 'domain_already_in_use' || code === 'forbidden') {
    const existing = await call('GET', `/v9/projects/${project()}/domains/${encodeURIComponent(host)}`);
    if (existing.status >= 200 && existing.status < 300) return stateOf(existing.json);
    return { verified: false, verification: [], inUseElsewhere: true };
  }
  if (status < 200 || status >= 300) throw refusal(json, `adding the domain failed (${status})`);
  return stateOf(json);
}

/** Ask Vercel to verify a host it had asked a TXT record for. */
export async function verifyProjectDomain(host: string): Promise<VercelDomainState> {
  const { status, json } = await call('POST', `/v9/projects/${project()}/domains/${encodeURIComponent(host)}/verify`);
  if (status < 200 || status >= 300) throw refusal(json, `verifying the domain failed (${status})`);
  return stateOf(json);
}

/** Whether the host's DNS reaches the deployment. */
export async function projectDomainConfig(host: string): Promise<{ misconfigured: boolean }> {
  const { status, json } = await call('GET', `/v6/domains/${encodeURIComponent(host)}/config`);
  if (status < 200 || status >= 300) throw refusal(json, `reading the domain configuration failed (${status})`);
  return { misconfigured: json.misconfigured !== false };
}

/** Remove the host from the project. A host that is not on it is already removed. */
export async function removeProjectDomain(host: string): Promise<void> {
  const { status, json } = await call('DELETE', `/v9/projects/${project()}/domains/${encodeURIComponent(host)}`);
  if (status === 404) return;
  if (status < 200 || status >= 300) throw refusal(json, `removing the domain failed (${status})`);
}
