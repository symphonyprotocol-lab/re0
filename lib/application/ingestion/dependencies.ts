/**
 * The three outside systems a build talks to, behind one seam.
 *
 * Passed in rather than imported at the point of use so a test can run the
 * whole pipeline -- fetch, scan, parse, chunk, embed, write, publish -- against
 * a fixed snapshot and an in-memory store. The alternative is a pipeline whose
 * only integration test needs a live repository, an embedding provider and an
 * S3 bucket, which in practice means a pipeline with no integration test.
 */
import { modelAdapters } from '@/lib/application/administration/manage-model-config';
import { resolvePageRenderer } from '@/lib/application/administration/manage-render-config';
import type { EmbeddingAdapter } from '@/lib/infrastructure/ai/providers';
import type { EvaluationDependencies } from './evaluate';
import { fetchSnapshot } from '@/lib/infrastructure/connectors';
import type { FetchSnapshotInput, SourceSnapshot } from '@/lib/infrastructure/connectors';
import type { ObjectStore } from '@/lib/infrastructure/objects/store';
import { isObjectStoreConfigured, objectStore } from '@/lib/infrastructure/objects/store';

const WEB_SOURCES = new Set<FetchSnapshotInput['type']>(['website', 'llms_txt', 'openapi']);

export interface IngestionDependencies {
  fetchSnapshot(input: FetchSnapshotInput): Promise<SourceSnapshot>;
  /**
   * Awaited, because the model is console configuration now rather than a
   * process environment: the default resolves a row and opens its credential.
   * A test's synchronous fake still satisfies this -- awaiting a plain value
   * is awaiting a resolved promise.
   */
  embeddings(): EmbeddingAdapter | Promise<EmbeddingAdapter>;
  store(): ObjectStore;
  /** Whether a build could run at all. Checked before anything is fetched. */
  configured():
    | { embeddings: boolean; storage: boolean }
    | Promise<{ embeddings: boolean; storage: boolean }>;
  /**
   * The retrieval a build's benchmark evaluation asks its test questions
   * through (ingestion/evaluate.ts). Absent means the installation's own --
   * what a caller's question would get, which is the point of the measurement.
   */
  retrieval?(): EvaluationDependencies;
}

export const defaultDependencies: IngestionDependencies = {
  /* The rendering fallback is console configuration, resolved once per
     source: the keys a source's first pages find spent stay set aside for
     the rest of its pages. Only web sources ever reach it. */
  fetchSnapshot: async (input) =>
    fetchSnapshot(
      input.renderer === undefined && WEB_SOURCES.has(input.type)
        ? { ...input, renderer: await resolvePageRenderer() }
        : input,
    ),
  /* Reached only after `configured()` said there was one, so a throw here is
     a model switched off between the check and the build rather than an
     installation that never configured one. */
  embeddings: () => modelAdapters().embeddings(),
  store: objectStore,
  configured: async () => ({
    embeddings: (await modelAdapters().configured()).embeddings,
    storage: isObjectStoreConfigured(),
  }),
};

/**
 * An in-memory store, for tests and for nothing else. `now` is the clock its
 * `uploadedAt` stamps come from, so a test can age an object.
 */
export function memoryObjectStore(
  now: () => number = Date.now,
): ObjectStore & { keys(): string[] } {
  const objects = new Map<string, { body: Uint8Array; uploadedAt: Date }>();
  return {
    keys: () => [...objects.keys()],
    async put(key, body) {
      objects.set(key, { body, uploadedAt: new Date(now()) });
    },
    async get(key) {
      return objects.get(key)?.body ?? null;
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.body.byteLength, contentType: null } : null;
    },
    async list(prefix) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({ key, uploadedAt: object.uploadedAt }));
    },
    async delete(key) {
      objects.delete(key);
    },
    async signedUrl(key) {
      return `memory://${key}`;
    },
    async uploadTicket(key) {
      return { kind: 'put', url: `memory://${key}?upload` };
    },
  };
}

/**
 * Whether this environment could build a version at all.
 *
 * Read by the console so an operator is told before they queue a refresh,
 * rather than by an operation that fails at `validate-source` minutes later
 * with a reason that was knowable up front.
 */
export async function isIngestionConfigured(): Promise<boolean> {
  const available = await defaultDependencies.configured();
  return available.embeddings && available.storage;
}
