/**
 * This deployment's own address, from `APP_BASE_URL`.
 *
 * Dependency free, like ./cookie-names, so the payment adapter can build its
 * checkout link from the same normalisation the OAuth callbacks use without
 * importing Next.js. Not to be confused with `PUBLIC_ORIGIN` (lib/site/origin),
 * which is the address printed in copy.
 */

/** The configured base URL without a trailing slash, or null when unset. */
export function configuredBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env.APP_BASE_URL?.trim().replace(/\/+$/, '');
  return url ? url : null;
}

export function appBaseUrl(): string {
  const url = configuredBaseUrl();
  if (!url) throw new Error('APP_BASE_URL is not set');
  return url;
}
