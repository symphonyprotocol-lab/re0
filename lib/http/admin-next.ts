/**
 * Where the console returns after sign-in (prototype suite.js admin login
 * `next`). Dependency-free, because the middleware builds the same link.
 */
export const ADMIN_HOME = '/admin/overview';
export const ADMIN_LOGIN = '/admin/login';

/**
 * A caller-supplied `next` as a console page, or null: it must be an
 * `/admin/…` path other than the sign-in page itself, with no `//`,
 * backslash or control character that could steer it off-site.
 */
export function safeAdminNext(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 1024) return null;
  if (!input.startsWith('/admin/') || input.includes('//') || input.includes('\\')) return null;
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  const path = (input.split('?')[0] ?? '').split('#')[0] ?? '';
  if (path === ADMIN_LOGIN || path.startsWith(`${ADMIN_LOGIN}/`)) return null;
  return input;
}

/** The sign-in page for a signed-out visit to `path` (path + query). */
export function adminLoginHref(path: string): string {
  const next = safeAdminNext(path);
  return next ? `${ADMIN_LOGIN}?next=${encodeURIComponent(next)}` : ADMIN_LOGIN;
}
