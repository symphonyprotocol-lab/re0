/**
 * Measures retrieval confirmation (lib/domain/routing.ts) against a real
 * library: for every question, the best chunk distance, the keyword evidence
 * and the verdict, then how many of the related and unrelated questions were
 * confirmed. The numbers next to CHUNK_CONFIRM_DISTANCE and
 * CHUNK_LOOSE_DISTANCE came from runs like this; re-measure before moving a
 * gate.
 *
 *   npx tsx scripts/measure-confirmation.mts --library /vercel/next.js \
 *     --related related.txt --unrelated unrelated.txt [--workspace <uuid>]
 *
 * Question files hold one question per line; blank lines and lines starting
 * with # are skipped. `--workspace` is needed for a private library of that
 * workspace; a public one can be read anonymously. Reads are unmetered, so
 * nothing is charged, and the questions are printed only here -- never
 * logged by the retrieval (architecture.md 17.1).
 *
 * `.mts` because the package is CommonJS by default and this needs top-level
 * await: the env has to be loaded before anything reads DATABASE_URL.
 */
import nextEnv from '@next/env';
import { readFileSync } from 'node:fs';

// `@next/env` is CommonJS, so it arrives as a default export under ESM.
nextEnv.loadEnvConfig(process.cwd());

const { queryDocsDetailed, defaultRetrievalDependencies } = await import(
  '@/lib/application/retrieval/query-docs'
);
const { confirmsRetrieval } = await import('@/lib/domain/routing');
const { containsCjk } = await import('@/lib/domain/cjk');

function option(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

function questions(path: string | null): string[] {
  if (!path) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

const libraryId = option('library');
if (!libraryId) {
  console.error('usage: --library /owner/name --related file [--unrelated file] [--workspace uuid]');
  process.exit(2);
}
const workspaceId = option('workspace');
const sets: [string, string[]][] = (
  [
    ['related', questions(option('related'))],
    ['unrelated', questions(option('unrelated'))],
  ] as [string, string[]][]
).filter(([, list]) => list.length > 0);
if (sets.length === 0) {
  console.error('no questions: pass --related and/or --unrelated files');
  process.exit(2);
}

const caller = workspaceId
  ? { workspaceId, apiKeyId: null, requestId: 'measure', anonymous: false, entrypoint: 'web' as const }
  : { workspaceId: null, apiKeyId: null, requestId: 'measure', anonymous: true, entrypoint: 'web' as const };
const dependencies = defaultRetrievalDependencies();

console.log(['set', 'verdict', 'distance', 'hits', 'evidence', 'question'].join('\t'));
for (const [label, list] of sets) {
  let confirmed = 0;
  for (const query of list) {
    try {
      const result = await queryDocsDetailed(
        caller,
        { libraryId, query, maxTokens: 6_000, format: 'json' },
        dependencies,
        { meter: false },
      );
      const corpusHasHan = result.chunks.some((chunk) => containsCjk(chunk.text));
      const verdict = result.confidence
        ? confirmsRetrieval(result.confidence, { crossScript: containsCjk(query) !== corpusHasHan })
        : false;
      if (verdict) confirmed += 1;
      const evidence = result.confidence?.keywordEvidence;
      console.log(
        [
          label,
          verdict ? 'YES' : 'no',
          result.confidence?.bestDistance?.toFixed(3) ?? 'null',
          result.confidence?.keywordHits ?? 0,
          evidence ? `${evidence.coveredTerms}/${evidence.queryTerms}${evidence.phrase ? '+phrase' : ''}` : '-',
          query,
        ].join('\t'),
      );
    } catch (error) {
      console.log([label, 'ERR', '', '', '', `${query}: ${error instanceof Error ? error.message : String(error)}`].join('\t'));
    }
  }
  console.log(`# ${label}: ${confirmed}/${list.length} confirmed`);
}
process.exit(0);
