/**
 * The signed-in workspace: the middleware sends a visitor without a session
 * cookie to sign in, and robots.txt keeps crawlers out (they would only
 * find that redirect).
 */
export const WORKSPACE_PATHS = ['/dashboard', '/rees', '/settings', '/talk', '/chats', '/workspace', '/videos'] as const;

/**
 * robots.txt's `Disallow`: the workspace, the console, the API and the
 * billing and redeem handlers. `/login`, `/checkout` and `/s/*` stay
 * crawlable on purpose: they carry `noindex` (and `/s/*` a canonical),
 * which a crawler can only read on a page it may fetch.
 */
export const CRAWL_DISALLOWED = ['/admin', '/api/', '/billing', '/redeem', ...WORKSPACE_PATHS] as const;
