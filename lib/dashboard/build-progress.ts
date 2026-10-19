/**
 * One line about where a running build is, for the screens that watch one:
 * the console's refresh queue and the workspace dashboard's library list
 * and detail page. The stage and the counts come from the operation row
 * (lib/domain/ingestion.ts `BuildProgress`); the words from the console's
 * dictionary, which the dashboard already borrows for ingestion errors.
 *
 * The most advanced count wins: chunks embedded over documents parsed over
 * files fetched, because each is known only once the one before it is done.
 */
import type { BuildProgress } from '@/lib/domain/ingestion';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';

export function buildProgressText(
  t: Pick<Dictionary['admin']['refreshQueue'], 'progress'>,
  progress: BuildProgress | null | undefined,
): string | null {
  if (!progress) return null;
  if (progress.chunksTotal !== undefined) {
    return fill(t.progress.chunks, {
      done: String(progress.chunksDone ?? 0),
      total: String(progress.chunksTotal),
    });
  }
  if (progress.documents !== undefined) return fill(t.progress.documents, { n: String(progress.documents) });
  if (progress.files !== undefined) return fill(t.progress.files, { n: String(progress.files) });
  return null;
}

/** "Embedding and indexing · embedded 4000 / 6108", or just the stage, or null before the first report. */
export function describeBuild(
  t: Pick<Dictionary['admin']['refreshQueue'], 'stages' | 'progress'>,
  build: { stage: string | null; progress: BuildProgress | null } | null | undefined,
): string | null {
  if (!build || !build.stage) return null;
  const stage = (t.stages as Record<string, string>)[build.stage] ?? build.stage;
  const figures = buildProgressText(t, build.progress);
  return figures ? `${stage} · ${figures}` : stage;
}
