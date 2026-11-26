/**
 * The web side of the agent workspace (`/api/files/*`): the signed-in owner
 * on their default workspace, at its root, through the same service the
 * `ws_*` MCP tools use, under the same `workspaceRead` / `workspaceWrite`
 * limits.
 */
import { fail } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { webScope, WorkspaceError, type WorkspaceScope } from '@/lib/services/workspace';
import { WorkspaceReeError } from '@/lib/services/workspace-rees';
import { ReeInputError } from '@/lib/services/rees';
import { PublishError } from '@/lib/services/workspace-publish';

export async function filesScope(request: Request, kind: 'read' | 'write'): Promise<WorkspaceScope | Response> {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited(kind === 'read' ? 'workspaceRead' : 'workspaceWrite', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  return webScope(user.id);
}

const STATUS: Partial<Record<WorkspaceError['code'], number>> = {
  not_found: 404,
  conflict: 409,
  exists: 409,
  insufficient_credits: 402,
  limit_reached: 429,
  too_large: 413,
  quota_exceeded: 413,
  max_cost_exceeded: 402,
};

/** A workspace refusal as the web's `{error}` body; anything else is rethrown. */
export function filesFailure(error: unknown): Response {
  if (error instanceof WorkspaceError) return fail(error.code, STATUS[error.code] ?? 422, error.details);
  if (error instanceof WorkspaceReeError) return fail(error.code, error.code === 'not_found' ? 404 : error.code === 'max_cost_exceeded' ? 402 : error.code === 'limit_reached' ? 429 : 422, error.details);
  if (error instanceof ReeInputError) return fail(error.field, 422, { step: error.step });
  throw error;
}

/** A publishing refusal (docs/design/agent-workspace-p4.md §2) as `{error}`, the checks included; else as `filesFailure`. */
export function publishFailure(error: unknown): Response {
  if (error instanceof PublishError) return fail(error.code, error.status, error.details);
  return filesFailure(error);
}
