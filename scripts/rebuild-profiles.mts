/**
 * Rebuilds the routing profile of every current asset version that an
 * older extractor wrote. Run after a PROFILE_VERSION bump:
 *
 *   npm run profiles:rebuild          # only profiles an older extractor wrote
 *   npm run profiles:rebuild -- --all # every current profile
 *
 * `.mts` for the same reason as create-administrator.mts: the env has to be
 * loaded before anything reads DATABASE_URL.
 */
import nextEnv from '@next/env';

// `@next/env` is CommonJS, so it arrives as a default export under ESM.
nextEnv.loadEnvConfig(process.cwd());

const { rebuildStaleProfiles } = await import('@/lib/application/ingestion/rebuild-profile');
const { PROFILE_VERSION } = await import('@/lib/domain/profile');

/* `--all` rebuilds every current profile, stale or not -- for an extractor
   change that kept its version number, or a profile suspected corrupt. */
const rebuilt = await rebuildStaleProfiles({ all: process.argv.includes('--all') });
if (rebuilt.length === 0) {
  console.log(`every current profile is already ${PROFILE_VERSION}`);
} else {
  for (const row of rebuilt) {
    console.log(`${row.publicId}: ${row.terms} terms, ${row.titles} titles (${row.versionId})`);
  }
}
process.exit(0);
