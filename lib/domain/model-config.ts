/**
 * The shapes a provider model configuration is held to. architecture.md 9.1,
 * 9.2, 15.3.
 *
 * Two kinds live here -- the embedding model retrieval's vector leg is built
 * and queried with, and the reranker that refines the fused head. Both are
 * singletons: unlike the generation registry, which holds several entries and
 * assigns them to audiences, there is exactly one embedding model an
 * installation is indexing with and one reranker in front of its results.
 *
 * Here rather than in `manage-model-config` because the console form needs
 * these bounds to hold its own inputs to what the server will accept, and
 * that module reaches the database. This layer has no imports at all, so it
 * is the one both sides can share.
 */

export const MODEL_KINDS = ['embedding', 'rerank'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export function isModelKind(value: unknown): value is ModelKind {
  return typeof value === 'string' && (MODEL_KINDS as readonly string[]).includes(value);
}

/**
 * The width of the stored vector columns (`chunk.embedding`,
 * `library_profile_vector.embedding`).
 *
 * A pgvector column's dimension is part of its type, and
 * `library_profile_vector` carries an HNSW index, which an unconstrained
 * `vector` column cannot have. So the column stays fixed and the *model's*
 * dimension is the configurable thing: a narrower model's vectors are
 * zero-padded to this width on the way in (`padToColumn`).
 *
 * Raising this is a migration, not a console save -- every stored vector has
 * to be rewritten to the new width. Lowering it is a rebuild.
 */
export const EMBEDDING_COLUMN_DIMENSIONS = 1536;

/**
 * What an entry may declare. The floor is what a usable sentence embedding
 * has ever been; the ceiling is the column, because a vector wider than the
 * column cannot be stored at all.
 */
export const EMBEDDING_DIMENSIONS = {
  min: 64,
  max: EMBEDDING_COLUMN_DIMENSIONS,
  default: EMBEDDING_COLUMN_DIMENSIONS,
} as const;

/**
 * Embedding is on the build path and rerank on the request path, so their
 * clocks differ by two orders of magnitude -- but both are bounded here
 * rather than in the adapters, so the console can refuse an impossible value
 * before a build spends an hour discovering it.
 */
export const EMBEDDING_TIMEOUT_MS = { min: 5_000, max: 300_000, default: 60_000 } as const;
export const RERANK_TIMEOUT_MS = { min: 500, max: 30_000, default: 5_000 } as const;

export function timeoutBoundsFor(kind: ModelKind): { min: number; max: number; default: number } {
  return kind === 'embedding' ? EMBEDDING_TIMEOUT_MS : RERANK_TIMEOUT_MS;
}

/**
 * Zero-pad a model's vector to the stored column width.
 *
 * Cosine distance is unchanged by the padding: the added coordinates
 * contribute nothing to either the dot product or to either magnitude, so a
 * 1024-dimensional model compared in a 1536-wide column ranks exactly as it
 * would in a 1024-wide one. That equivalence is the whole reason the column
 * can stay fixed while the model's dimension is configuration.
 *
 * Throws on a vector wider than the column: silently truncating would change
 * the geometry the model was trained to produce, and the caller has a
 * configured width it can check against first.
 */
export function padToColumn(vector: readonly number[]): number[] {
  if (vector.length > EMBEDDING_COLUMN_DIMENSIONS) {
    throw new Error(
      `embedding of ${vector.length} dimensions does not fit the ${EMBEDDING_COLUMN_DIMENSIONS}-wide column`,
    );
  }
  if (vector.length === EMBEDDING_COLUMN_DIMENSIONS) return [...vector];
  const padded = new Array<number>(EMBEDDING_COLUMN_DIMENSIONS).fill(0);
  for (let at = 0; at < vector.length; at += 1) padded[at] = vector[at]!;
  return padded;
}

/** A credential typed into the console. Long enough for any vendor's format. */
export const API_KEY_MAX_LENGTH = 512;

/**
 * Whether a stored credential may be sent to `next`, having been saved for
 * `stored`.
 *
 * A stored key is only ever carried forward -- to a re-minted entry, or to a
 * probe -- when the endpoint keeps its origin. Otherwise anyone holding the
 * `models` capability could point an existing entry at a host of their own,
 * leave the key field blank, and receive a key somebody else typed as a
 * Bearer header. Changing the host means typing the key again, which is
 * exactly the proof that the operator already had it.
 */
export function mayCarryCredential(stored: string, next: string): boolean {
  try {
    return new URL(stored).origin === new URL(next).origin;
  } catch {
    return false;
  }
}
