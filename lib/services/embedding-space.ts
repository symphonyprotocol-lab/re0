/**
 * Embedding spaces: which vectors may be compared with which.
 *
 * Vectors of two embedding models mean nothing to each other, so every
 * stored vector carries the space it was made in -- a uuid -- and every
 * comparison stays inside one space. A chunk has two vector slots
 * (`embedding`, `embedding_next`), each with its own tag; profile vectors
 * have one. The enabled embedding entry names the active space
 * (`model_config.embedding_space`); a re-embed job fills each chunk's spare
 * slot in its own new space and switches by enabling the candidate with that
 * space: one row, however many chunks there are (reembed.ts).
 *
 * A question is embedded once and carries the space of the entry that
 * embedded it (`spaceOf`); retrieval reads only vectors of that space. A
 * query in flight across a switch therefore keeps reading the old space,
 * whose vectors are only cleaned up a grace period after the switch
 * (`cleanupEmbeddingSpaces`), and a chunk with no vector in a space is
 * simply not found in it -- never compared across models.
 *
 * The base space is everything made before spaces existed (0044): untagged
 * vectors, the environment's model, and an entry enabled before then.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { ModelEndpoint } from '@/lib/infra/ai/models';

export const BASE_SPACE = '00000000-0000-0000-0000-000000000000';

/** The space of the vectors an endpoint makes (as of when the endpoint was read). */
export function spaceOf(endpoint: Pick<ModelEndpoint, 'space'>): string {
  return endpoint.space ?? BASE_SPACE;
}

/** The active space, inside the statement that uses it: the enabled entry's. */
export const activeSpace: SQL = sql`coalesce((select m.embedding_space from model_config m where m.kind = 'embedding' and m.enabled), ${BASE_SPACE}::uuid)`;

function column(table: string, name: string): SQL {
  return sql.raw(`"${table}"."${name}"`);
}

/**
 * The chunk's vector in `space`, from whichever slot holds it; null when it
 * has none there. `table` is the name or alias the chunk table has in the query.
 */
export function chunkVector(space: string | SQL, table = 'chunk'): SQL {
  const target = typeof space === 'string' ? sql`${space}::uuid` : sql`(${space})`;
  return sql`(case when coalesce(${column(table, 'embedding_space')}, ${BASE_SPACE}::uuid) = ${target} then ${column(table, 'embedding')} when ${column(table, 'embedding_next_space')} = ${target} then ${column(table, 'embedding_next')} end)`;
}

/** Whether the chunk has a vector in `space`. A job's space is never the base space, so the tags alone answer. */
export function chunkHasSpace(space: string, table = 'chunk'): SQL {
  return sql`(${chunkVector(space, table)} is not null)`;
}

/** A profile vector row of `space`. */
export function profileInSpace(space: string, table = 'ree_profile_vector'): SQL {
  return sql`coalesce(${column(table, 'embedding_space')}, ${BASE_SPACE}::uuid) = ${space}::uuid`;
}
