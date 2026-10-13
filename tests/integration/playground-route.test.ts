/**
 * The playground BFF, against a real database. architecture.md 9.6's web
 * entry: the server routes the question to the top candidate library and
 * answers from it -- and with no LLM configured (as here), the transcript
 * degrades to retrieved passages with sources, never an error.
 *
 * The response is a UI message stream, so the assertions read the parts off
 * the wire. That the stream carries no text part is itself the check that
 * matters: requirement.md 5.1 rule 5 is enforced by there being no channel
 * through which unbound prose could reach the client.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
/* No model entry exists in a fresh test database, so the route degrades to
   the excerpt list -- which is what this file is here to pin down. */

const { buildVersion, memoryObjectStore, publishVersion } = await import(
  '@/lib/application/ingestion'
);
const { createPlatformLibrary } = await import(
  '@/lib/application/administration/manage-platform-libraries'
);
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { POST: playgroundRoute } = await import('@/app/api/playground/route');

const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };
const created: string[] = [];
const store = memoryObjectStore();

function dependencies() {
  return {
    async fetchSnapshot() {
      return {
        files: [
          {
            path: 'docs/tides.md',
            url: 'https://example.test/tides',
            content:
              '# Tidal Notes\n\nThe zug-tide tables are recalibrated every solstice using shoreline markers.',
          },
        ],
        config: {
          projectTitle: null,
          description: null,
          branch: null,
          folders: [],
          excludeFolders: [],
          excludeFiles: [],
          rules: [],
        },
        revision: 'fixture-revision',
        lastModifiedAt: new Date(),
        hasLicense: true,
        stale: false,
      };
    },
    embeddings: () => ({
      model: 'fixture-embed-1',
      dimensions: EMBEDDING_COLUMN_DIMENSIONS,
      async embed(texts: string[]) {
        return texts.map((text) =>
          Array.from({ length: EMBEDDING_COLUMN_DIMENSIONS }, (_, i) => ((text.length + i) % 17) / 17),
        );
      },
    }),
    store: () => store,
    configured: () => ({ embeddings: true, storage: true }),
  };
}

async function publishedLibrary(slug: string): Promise<string> {
  const { libraryId } = await createPlatformLibrary({
    actor,
    title: `Playground route fixture ${slug}`,
    publicId: `/websites/${slug}`,
    sourceType: 'website',
    location: `https://example.test/${slug}`,
    refreshPolicy: 'manual',
    language: 'en',
    reason: 'integration test fixture',
  });
  created.push(libraryId);
  const built = await buildVersion({ libraryId, operationId: uuidv7(), dependencies: dependencies() });
  if (!built.changed) throw new Error('fixture build produced no version');
  await publishVersion({ libraryId, versionId: built.versionId });
  await db()
    .update(schema.library)
    .set({ lifecycleStatus: 'published' })
    .where(eq(schema.library.id, libraryId));
  return libraryId;
}

function ask(question: unknown): NextRequest {
  return new NextRequest('https://example.test/api/playground', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
  });
}

describeWithDb('playground route', () => {
  afterAll(async () => {
    const database = db();
    if (created.length === 0) return;
    await database
      .update(schema.library)
      .set({ currentVersionId: null })
      .where(inArray(schema.library.id, created));
    await database
      .delete(schema.libraryProfileVector)
      .where(inArray(schema.libraryProfileVector.libraryId, created));
    await database
      .delete(schema.libraryProfile)
      .where(inArray(schema.libraryProfile.libraryId, created));
    await database.delete(schema.chunk).where(inArray(schema.chunk.libraryId, created));
    await database.delete(schema.document).where(inArray(schema.document.libraryId, created));
    await database
      .delete(schema.libraryVersion)
      .where(inArray(schema.libraryVersion.libraryId, created));
    await database
      .delete(schema.libraryScore)
      .where(inArray(schema.libraryScore.libraryId, created));
    await database.delete(schema.source).where(inArray(schema.source.libraryId, created));
    await database
      .delete(schema.libraryAlias)
      .where(inArray(schema.libraryAlias.libraryId, created));
    await database.delete(schema.auditLog).where(inArray(schema.auditLog.targetId, created));
    await database.delete(schema.library).where(inArray(schema.library.id, created));
  });

  it('routes to the top library and degrades to sourced passages without an LLM', async () => {
    const stamp = Date.now();
    await publishedLibrary(`pgr-route-${stamp}`);

    const response = await playgroundRoute(ask('when are zug-tide tables recalibrated'));
    expect(response.status).toBe(200);
    const parts = await readStream(response);

    const routing = partData<{ libraryId: string | null; candidates: { libraryId: string }[] }>(
      parts,
      'data-routing',
    );
    expect(routing?.libraryId).toBe(`/websites/pgr-route-${stamp}`);
    expect(routing?.candidates.map((c) => c.libraryId)).toContain(`/websites/pgr-route-${stamp}`);

    const sources = partData<{ sources: { sourceUrl: string }[] }>(parts, 'data-sources');
    expect(sources?.sources[0]?.sourceUrl).toBe('https://example.test/tides');

    expect(partData<{ kind: string }>(parts, 'data-outcome')?.kind).toBe('degraded');
    /* No claims and no text part: nothing was presented as fact. */
    expect(parts.filter((part) => part.type === 'data-claim')).toHaveLength(0);
    expect(parts.some((part) => part.type.startsWith('text'))).toBe(false);
  });

  it('says so when no library matches, and refuses bad input', async () => {
    const missing = await playgroundRoute(ask('zzz-quantum-flux-nothing-zzz'));
    expect(missing.status).toBe(200);
    const parts = await readStream(missing);
    expect(partData<{ kind: string }>(parts, 'data-outcome')?.kind).toBe('no_library');
    expect(parts.filter((part) => part.type === 'data-sources')).toHaveLength(0);

    /* Bad input is refused before the stream opens, so it is still a status. */
    const empty = await playgroundRoute(ask(''));
    expect(empty.status).toBe(400);
  });
});

interface StreamPart {
  type: string;
  data?: unknown;
}

/** Collect the SSE frames of a UI message stream into their parts. */
async function readStream(response: Response): Promise<StreamPart[]> {
  const body = await response.text();
  const parts: StreamPart[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    parts.push(JSON.parse(payload) as StreamPart);
  }
  return parts;
}

function partData<T>(parts: StreamPart[], type: string): T | null {
  const found = parts.find((part) => part.type === type);
  return found ? (found.data as T) : null;
}
