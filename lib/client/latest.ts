/**
 * Ordering guard for requests that can overlap (a poll and a user's click,
 * previous / next in a preview): each `begin()` hands out a ticket, and only
 * the most recent ticket is still `current()` when its response arrives, so
 * a late answer to an older request never overwrites newer state.
 */
export function latestRequest(): () => () => boolean {
  let latest = 0;
  return () => {
    const ticket = ++latest;
    return () => ticket === latest;
  };
}
