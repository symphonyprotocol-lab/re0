/**
 * Cookie names and attributes. Dependency-free, because the middleware reads
 * the same names. `__Host-` / `__Secure-` prefixes only over HTTPS, where
 * browsers accept them.
 */
export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')).replace(/\/+$/, '');
}

export function isSecureDeployment(): boolean {
  return appBaseUrl().startsWith('https://');
}

export const SESSION_COOKIE = isSecureDeployment() ? '__Host-re0_session' : 're0_session';
export const HANDSHAKE_COOKIE = isSecureDeployment() ? '__Host-re0_oauth' : 're0_oauth';
/** Path `/` so `/api/admin/*` receives it too; a different name and table from the user session. */
export const ADMIN_SESSION_COOKIE = isSecureDeployment() ? '__Host-re0_admin' : 're0_admin';
export const LOCALE_COOKIE = 're0_lang';
export const SIDEBAR_COOKIE = 're0_sidebar';

export function cookieOptions(expires?: Date) {
  return {
    httpOnly: true,
    secure: isSecureDeployment(),
    sameSite: 'lax' as const,
    path: '/',
    ...(expires ? { expires } : {}),
  };
}
