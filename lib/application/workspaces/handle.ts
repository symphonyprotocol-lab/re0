/**
 * Workspace handles (agent-first-proposal.md 12): the public name in
 * `/u/{handle}` and in the user Agent Card's tenant. The rules of what a
 * handle may be are lib/domain/handle.ts; uniqueness is the
 * `workspace_handle_uq` index, which this reads ahead of so a person gets a
 * sentence instead of a driver error.
 */
import { eq, inArray } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { handleRefusal, normalizeHandle, suffixedHandle, suggestHandle, type HandleRefusal } from '@/lib/domain/handle';
import { db, schema, type Database } from '@/lib/infrastructure/postgres/client';

type Reader = Pick<Database, 'select'>;

/** How many alternatives signup tries before settling for a digest-only handle. */
const SUGGESTION_ATTEMPTS = 6;

/**
 * A free handle for a new workspace, from the email it was created for. Read
 * against the index first; a collision with a concurrent signup in the gap is
 * left to the unique index, which fails that login rather than sharing a name.
 */
export async function freeHandleFor(reader: Reader, email: string, workspaceId: string): Promise<string> {
  const base = suggestHandle(email, workspaceId);
  const candidates = [base];
  for (let attempt = 1; attempt < SUGGESTION_ATTEMPTS; attempt += 1) {
    candidates.push(suffixedHandle(base, attempt, workspaceId));
  }
  const taken = await reader
    .select({ handle: schema.workspace.handle })
    .from(schema.workspace)
    .where(inArray(schema.workspace.handle, candidates));
  const used = new Set(taken.map((row) => row.handle));
  return candidates.find((candidate) => !used.has(candidate)) ?? `user-${workspaceId.replace(/-/g, '').slice(-12)}`;
}

export async function workspaceHandle(workspaceId: string): Promise<string | null> {
  const [row] = await db()
    .select({ handle: schema.workspace.handle })
    .from(schema.workspace)
    .where(eq(schema.workspace.id, workspaceId))
    .limit(1);
  return row?.handle ?? null;
}

export class HandleRefused extends Error {
  constructor(readonly code: HandleRefusal | 'taken') {
    super(`handle refused: ${code}`);
    this.name = 'HandleRefused';
  }
}

/**
 * Changes the workspace's handle. Owner only: it renames the public page and
 * the user card every caller has written down. The old handle is released at
 * once -- there are no redirects (proposal 1).
 */
export async function changeWorkspaceHandle(input: {
  workspaceId: string;
  role: 'owner' | 'admin' | 'member' | string;
  handle: string;
}): Promise<string> {
  if (input.role !== 'owner') {
    throw new AppError('access_denied', 'only the workspace owner can change its handle');
  }
  const folded = input.handle.trim().toLowerCase();
  const refusal = handleRefusal(folded);
  if (refusal) throw new HandleRefused(refusal);
  const handle = normalizeHandle(folded)!;
  const database = db();
  const [holder] = await database
    .select({ id: schema.workspace.id })
    .from(schema.workspace)
    .where(eq(schema.workspace.handle, handle))
    .limit(1);
  if (holder && holder.id !== input.workspaceId) throw new HandleRefused('taken');
  try {
    await database.update(schema.workspace).set({ handle }).where(eq(schema.workspace.id, input.workspaceId));
  } catch (error) {
    const message = [
      error instanceof Error ? error.message : '',
      error instanceof Error && error.cause instanceof Error ? error.cause.message : '',
    ].join(' ');
    if (message.includes('workspace_handle_uq')) throw new HandleRefused('taken');
    throw error;
  }
  return handle;
}
