/**
 * The seed script's safety check (scripts/seed-posts.mts): a database on
 * this machine is fine; anything else -- a Neon host, any remote name -- is
 * refused unless the administrator says, in so many words, that it is
 * production. Null when the target may be used; the refusal otherwise.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

export function seedTargetCheck(databaseUrl: string, productionConfirmed: boolean): string | null {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return 'The --database-url is not a URL.';
  }
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return null;
  if (productionConfirmed) return null;
  return `Refusing ${host}: it is not a database on this machine. Pass --i-know-this-is-production to seed it on purpose (it posts and pays for answers there).`;
}
