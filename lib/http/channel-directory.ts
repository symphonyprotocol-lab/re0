/**
 * The channel directory as the public pages read it: ranked once and kept
 * for a couple of minutes. Ranking reads every public channel with its
 * visitors and scores (lib/application/channels/directory.ts), which is the
 * heaviest query on the busiest pages, and the order does not need to move
 * faster than that. A channel's own page and the dashboard read live.
 */
import { unstable_cache } from 'next/cache';
import { listChannelDirectory } from '@/lib/application/channels';
import type { DirectorySort } from '@/lib/domain/channel';

export const DIRECTORY_REVALIDATE_SECONDS = 120;

export const cachedChannelDirectory = unstable_cache(
  (sort: DirectorySort, limit: number, offset: number) => listChannelDirectory({ sort, limit, offset }),
  ['channel-directory'],
  { revalidate: DIRECTORY_REVALIDATE_SECONDS },
);
