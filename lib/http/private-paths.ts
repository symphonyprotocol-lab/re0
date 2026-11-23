/**
 * The signed-in workspace: the middleware sends a visitor without a session
 * cookie to sign in, and robots.txt keeps crawlers out (they would only
 * find that redirect). `/talk` and `/chats` only redirect to the composer
 * and 我的帖子 now (2026-11-20), both signed-in places, so they stay listed.
 */
export const WORKSPACE_PATHS = ['/dashboard', '/rees', '/activities', '/settings', '/talk', '/chats', '/workspace', '/videos', '/me', '/notifications', '/saved'] as const;

/**
 * robots.txt's `Disallow`: the workspace, the console, the API and the
 * billing and redeem handlers. `/login`, `/checkout` and `/s/*` stay
 * crawlable on purpose: they carry `noindex` (and `/s/*` a canonical),
 * which a crawler can only read on a page it may fetch. robots.txt matches
 * by plain prefix, so `/me` is listed as `/me/`: `/media/*` (Ree images)
 * stays crawlable. `/login?` (2026-11-23, GSC): every public page links
 * to sign in with its own `returnTo`, and Google spent most of its crawl
 * on those copies of one noindex page (2,964 of 5.34k not indexed); bare
 * `/login` stays open.
 */
export const CRAWL_DISALLOWED = ['/admin', '/api/', '/billing', '/redeem', '/login?', ...WORKSPACE_PATHS.map((path) => (path === '/me' ? '/me/' : path))] as const;
