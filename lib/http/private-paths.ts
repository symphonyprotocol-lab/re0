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
 * `/login` stays open. QUERY_VARIANTS_DISALLOWED below are the rest.
 */
export const CRAWL_DISALLOWED = ['/admin', '/api/', '/billing', '/redeem', '/login?', ...WORKSPACE_PATHS.map((path) => (path === '/me' ? '/me/' : path))] as const;

/**
 * robots.txt's wildcard `Disallow`s (`*` is any run of characters, as
 * Google, Bing and the AI crawlers read it): the query copies of public
 * pages, which carry nothing a crawler needs. 2026-11-20..23, ClaudeBot
 * fetched `/r/[slug]` 3.0M times (454 GB of origin transfer, ~$155) over
 * only ~7.7k paths: 同一创作者的更多 Ree's `?ap=N` pager gave every Ree
 * ~730 pages (2.9k Rees × 730 × 2 languages ≈ 4M URLs).
 *
 * - `ap` (that pager), in either position.
 * - A Ree page's `?tab=` (comments, intro: the same page, another tab open).
 * - `compose` (the composer window over whatever page; `?compose=…&ree=…
 *   &name=…` on a Ree, `&quote=…` on a post) and `?video=1` (the intro
 *   video's share link, which only starts the video).
 *
 * Named parameters, not "any query on /r/ or /p/": a Ree's preview image
 * is `/r/<slug>/opengraph-image-<id>?<hash>`, and link-preview bots read
 * robots.txt too. Left open on purpose: `/explore?category=` (in the
 * sitemap), `/explore?q=` (a Ree's tag links, noindex) and
 * `/explore?page=` -- all of /explore was 3.5 GB of the same week's
 * 530 GB -- and `/?tab=` (the front page's two feed tabs).
 */
export const QUERY_VARIANTS_DISALLOWED = ['/*?ap=', '/*&ap=', '/*/r/*?tab=', '/*?compose=', '/*&compose=', '/*?video='] as const;
