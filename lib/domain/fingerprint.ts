/**
 * A content sketch for duplicate detection, as pure functions.
 * review-visibility-proposal.md 6.1 ("重复").
 *
 * A mirror or a wholesale re-upload of a published library should not
 * reach a reviewer as a fresh submission. Comparing every chunk of every
 * library is not affordable; comparing a bottom-k sketch is. Each chunk
 * body is normalised and hashed, and the k smallest hashes are the
 * version's sketch. Two sketches estimate their Jaccard similarity from
 * the k smallest hashes of their union -- the share of those that both
 * sets contain -- which is the standard bottom-k estimator. It catches
 * copies and near-copies; a library that quotes another in passing scores
 * low, as it should.
 */

export const SKETCH_SIZE = 128;

/** FNV-1a over UTF-16 code units, 64-bit, as 16 hex digits. Cheap and deterministic; not a security hash. */
export function fingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= BigInt(text.charCodeAt(at));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Case, punctuation runs and whitespace runs are not what makes two passages the same. */
export function normalizeForSketch(body: string): string {
  return body
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, ' ')
    .trim();
}

/** The version's sketch: the `k` smallest fingerprints of its distinct normalised chunks, sorted. */
export function contentSketch(bodies: readonly string[], k = SKETCH_SIZE): string[] {
  const hashes = new Set<string>();
  for (const body of bodies) {
    const normalised = normalizeForSketch(body);
    if (normalised.length > 0) hashes.add(fingerprint(normalised));
  }
  return [...hashes].sort().slice(0, k);
}

/**
 * Estimated Jaccard similarity of the two sets the sketches were taken
 * from, 0 to 100. Zero when either sketch is empty.
 */
export function sketchSimilarity(a: readonly string[], b: readonly string[], k = SKETCH_SIZE): number {
  if (a.length === 0 || b.length === 0) return 0;
  const inA = new Set(a);
  const inB = new Set(b);
  const union = [...new Set([...a, ...b])].sort().slice(0, Math.min(k, a.length + b.length));
  const both = union.filter((hash) => inA.has(hash) && inB.has(hash)).length;
  return Math.round((both / union.length) * 100);
}
