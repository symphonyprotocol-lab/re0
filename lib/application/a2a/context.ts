/**
 * What an A2A call carries through the SDK: who is calling and on which
 * tenant (agent-first-proposal.md 7.1, 7.4, 7.8).
 *
 * The Route Handler authenticates (API-key Bearer, or anonymous under the
 * anonymous rate limit) and resolves the tenant before the SDK sees the
 * request; both ride on the `ServerCallContext` -- the caller as the SDK's
 * `User` plus our own state, the tenant in `context.tenant` -- so the task
 * store scopes by them and the executor acts as them. Nothing downstream
 * re-reads a header.
 */
import { ServerCallContext, type User } from '@a2a-js/sdk/server';
import type { CallerContext } from '@/lib/application/retrieval';
import type { A2ATenant } from './tenant';

const CALLER_KEY = 're0.caller';
const TENANT_KEY = 're0.tenant';
const VISITOR_KEY = 're0.visitor';

/** The SDK's view of a caller: a workspace, or nobody. */
export class Re0User implements User {
  constructor(private readonly workspaceId: string | null) {}
  get isAuthenticated(): boolean {
    return this.workspaceId !== null;
  }
  get userName(): string {
    return this.workspaceId ?? 'anonymous';
  }
}

export interface A2ACallFacts {
  caller: CallerContext;
  tenant: A2ATenant;
  /** The hashed anonymous key, for counting distinct visitors (channels/visits.ts); null when keyed. */
  anonymousVisitor: string | null;
  requestedVersion?: string;
  /**
   * Set when the tenant came from the URL path rather than the request body:
   * the context is built with it so a body without `tenant` still lands on
   * the right card. A body that names a tenant sets it through the SDK.
   */
  pathTenant: boolean;
}

export function buildCallContext(facts: A2ACallFacts): ServerCallContext {
  const state = new Map<string, unknown>([
    [CALLER_KEY, facts.caller],
    [TENANT_KEY, facts.tenant],
    [VISITOR_KEY, facts.anonymousVisitor],
  ]);
  return new ServerCallContext({
    user: new Re0User(facts.caller.workspaceId),
    requestedVersion: facts.requestedVersion,
    ...(facts.pathTenant && facts.tenant.key ? { tenant: facts.tenant.key } : {}),
    state,
  });
}

export function callerOf(context: ServerCallContext): CallerContext {
  const caller = context.state.get(CALLER_KEY) as CallerContext | undefined;
  /* A context this module did not build is an anonymous one, never a privileged one. */
  return caller ?? { workspaceId: null, apiKeyId: null, requestId: 'a2a-unknown', anonymous: true, entrypoint: 'a2a' };
}

export function resolvedTenantOf(context: ServerCallContext): A2ATenant | undefined {
  return context.state.get(TENANT_KEY) as A2ATenant | undefined;
}

/**
 * The tenant key the store scopes by: the resolved one, normalised, so
 * `Channels/Rust-Notes` and `channels/rust-notes` are one tenant; the raw
 * request value only for a context this module did not build.
 */
export function tenantOf(context: ServerCallContext): string {
  return resolvedTenantOf(context)?.key ?? context.tenant ?? '';
}

export function anonymousVisitorOf(context: ServerCallContext): string | null {
  return (context.state.get(VISITOR_KEY) as string | null | undefined) ?? null;
}
