/**
 * GET /embed?key=...&parent=...&lang=... -- the widget page the loader puts
 * in its iframe. requirement.md 9.4, lib/application/embed.
 *
 * A Route Handler rather than a page, because the whole point of this
 * document is one response header: `Content-Security-Policy: frame-ancestors`
 * listing exactly the origins the owner allowed. The browser then refuses to
 * render it inside any other site -- which is the gate a publishable key
 * cannot be. A page component cannot set that header per key; a handler can.
 *
 * The document itself is small and static: a stylesheet, a script and a JSON
 * block with what this key's widget looks like and says. The script
 * (public/embed-app.js) does the talking to /api/embed/ask and to the loader
 * in the parent page (public/widget.js) through postMessage.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { resolveSiteKey, type SiteKeyPrincipal } from '@/lib/application/embed';
import { originAllowed, frameAncestors } from '@/lib/domain/site-key';
import { messagesFor } from '@/lib/i18n/dictionary';
import { HTML_LANG, negotiateLocale } from '@/lib/i18n/locale';

export const runtime = 'nodejs';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** JSON inside a `<script>`: `<` must not be able to close the element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function document(input: {
  lang: string;
  title: string;
  head: string;
  body: string;
}): string {
  return `<!doctype html>
<html lang="${input.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(input.title)}</title>
${input.head}
</head>
<body>
${input.body}
</body>
</html>`;
}

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const parent = url.searchParams.get('parent');
  const locale = negotiateLocale(url.searchParams.get('lang') || request.headers.get('accept-language'));
  const t = messagesFor(locale).embed;
  const lang = HTML_LANG[locale];

  let principal: SiteKeyPrincipal;
  try {
    principal = await resolveSiteKey(key);
  } catch (error) {
    const status = error instanceof AppError && error.code === 'invalid_api_key' ? 404 : 500;
    if (status === 500) {
      console.error(`embed page failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
    return new Response(
      document({
        lang,
        title: t.unavailableTitle,
        head: '<link rel="stylesheet" href="/embed-app.css">',
        body: `<main class="re0-notice"><p>${escapeHtml(status === 404 ? t.unknownKey : t.error)}</p></main>`,
      }),
      {
        status,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-store',
          'content-security-policy': "frame-ancestors 'none'",
        },
      },
    );
  }

  /*
   * The header is what enforces the allowlist; the status is for a reader
   * who opens the URL directly from a site that is not on it. Either way the
   * list sent is the owner's, never widened by the parent the loader claims.
   */
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-store',
    'content-security-policy': frameAncestors(principal.allowedOrigins),
    'x-content-type-options': 'nosniff',
  };

  if (!originAllowed(principal.allowedOrigins, parent)) {
    return new Response(
      document({
        lang,
        title: t.unavailableTitle,
        head: '<link rel="stylesheet" href="/embed-app.css">',
        body: `<main class="re0-notice"><p>${escapeHtml(t.originRefused)}</p></main>`,
      }),
      { status: 403, headers },
    );
  }

  const config = {
    key,
    parent,
    accent: principal.accent,
    title: principal.libraryTitle,
    welcome: principal.welcome ?? t.welcomeDefault,
    ready: principal.ready,
    strings: {
      placeholder: t.placeholder,
      send: t.send,
      sources: t.sources,
      open: t.open,
      noContext: t.noContext,
      searchedAs: t.searchedAs,
      degraded: t.degraded,
      notReady: t.notReady,
      limitReached: t.limitReached,
      rateLimited: t.rateLimited,
      error: t.error,
      poweredBy: t.poweredBy,
      close: t.close,
      thinking: t.thinking,
    },
  };

  const body = `<div id="re0-widget" class="re0-widget" style="--re0-accent:${escapeHtml(principal.accent)}">
  <header class="re0-header">
    <div class="re0-header-text">
      <p class="re0-title">${escapeHtml(principal.libraryTitle)}</p>
      <p class="re0-subtitle">${escapeHtml(t.subtitle)}</p>
    </div>
    <button type="button" class="re0-close" id="re0-close" aria-label="${escapeHtml(t.close)}">&#x2715;</button>
  </header>
  <div class="re0-transcript" id="re0-transcript" aria-live="polite"></div>
  <form class="re0-composer" id="re0-form">
    <input class="re0-input" id="re0-input" type="text" autocomplete="off" maxlength="2000" placeholder="${escapeHtml(t.placeholder)}" aria-label="${escapeHtml(t.placeholder)}">
    <button type="submit" class="re0-send" id="re0-send">${escapeHtml(t.send)}</button>
  </form>
  <p class="re0-footer">${escapeHtml(t.poweredBy)} <a href="https://re0.io" target="_blank" rel="noreferrer">re0</a></p>
</div>
<script type="application/json" id="re0-config">${scriptJson(config)}</script>
<script src="/embed-app.js" defer></script>`;

  return new Response(
    document({
      lang,
      title: principal.libraryTitle,
      head: '<link rel="stylesheet" href="/embed-app.css">',
      body,
    }),
    { status: 200, headers },
  );
}
