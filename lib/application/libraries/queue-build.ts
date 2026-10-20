/**
 * One rule for every owner edit that must reach the next build -- files
 * saved, FAQ entries changed: a pending build has not read the library yet
 * and will pick the change up, so nothing is queued; a running one has
 * already read it, so a new row goes behind it (`workflow_operation_uq`
 * does not collide on a null digest, and the worker's digest check makes an
 * extra build cheap). architecture.md 8.4.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';

/** The operation types that build a version, and so can be "already queued". */
export const BUILD_OPERATIONS = ['ingest', 'refresh'] as const;

type Executor = Pick<ReturnType<typeof db>, 'select' | 'insert'>;

export async function openBuild(
  reader: Pick<Executor, 'select'>,
  libraryId: string,
): Promise<{ id: string; status: string } | null> {
  const [open] = await reader
    .select({ id: schema.workflowOperation.id, status: schema.workflowOperation.status })
    .from(schema.workflowOperation)
    .where(
      and(
        eq(schema.workflowOperation.libraryId, libraryId),
        inArray(schema.workflowOperation.operationType, [...BUILD_OPERATIONS]),
        inArray(schema.workflowOperation.status, ['pending', 'running']),
      ),
    )
    .orderBy(desc(schema.workflowOperation.createdAt))
    .limit(1);
  return open ?? null;
}

/** The build the change rides on: the waiting one, or a new refresh behind whatever runs. */
export async function queueBuildUnlessPending(executor: Executor, libraryId: string): Promise<string> {
  const open = await openBuild(executor, libraryId);
  if (open?.status === 'pending') return open.id;
  const operationId = uuidv7();
  await executor.insert(schema.workflowOperation).values({
    id: operationId,
    libraryId,
    operationType: 'refresh',
    sourceDigest: null,
    status: 'pending',
  });
  return operationId;
}
