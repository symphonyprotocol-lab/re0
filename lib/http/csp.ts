/**
 * The Content-Security-Policy every HTML page is sent with (rebuild review
 * M14), built per request in middleware.ts around a fresh nonce.
 *
 * Scripts: only Next's own (it stamps the nonce from the request's CSP header
 * on its bootstrap and chunk tags) and what those scripts load in turn
 * ('strict-dynamic': next/script's Paddle.js tag, Paddle's own loader, the
 * lazy-loaded Remotion chunks). 'self' and cdn.paddle.com are a fallback for
 * browsers without 'strict-dynamic', which ignore it in favour of the nonce.
 * No 'unsafe-inline' for scripts. 'wasm-unsafe-eval' is the in-browser video
 * export (@remotion/web-renderer pulls in @mediabunny/aac-encoder, a WASM
 * build); 'unsafe-eval' is development only (React's dev tooling).
 *
 * Styles keep 'unsafe-inline': React renders `style="..."` attributes on the
 * server, which a nonce cannot cover. Workers and media allow blob: (the
 * export's timer and encoder workers, local previews of picked files). Images:
 * this origin (`/media`, `/_next/image`), data:/blob: previews, the OAuth
 * providers' avatar hosts and Vercel Blob (the console's signed KYC links).
 * Connections: this origin (every AI stream is under /api), Vercel Blob's
 * client upload (vercel.com/api/blob, then the store) and Paddle checkout.
 * Frames: Paddle's checkout overlay only. Forms: this origin, plus the OAuth
 * providers a sign-in POST redirects to.
 */
export interface PolicyOptions {
  nonce: string;
  dev?: boolean;
  /** PADDLE_ENVIRONMENT=sandbox: Paddle.js then pulls its stylesheet from the sandbox CDN. */
  paddleSandbox?: boolean;
}

/** Paddle.js itself is always served from here, sandbox or not. */
export const PADDLE_SCRIPT = 'https://cdn.paddle.com';
const PADDLE_SANDBOX_CDN = 'https://sandbox-cdn.paddle.com';
/** The checkout overlay's frame and its API calls (buy / sandbox-buy, checkout-service, ...). */
export const PADDLE_HOSTS = 'https://*.paddle.com';
const BLOB_HOSTS = 'https://*.blob.vercel-storage.com';

export function contentSecurityPolicy({ nonce, dev = false, paddleSandbox = false }: PolicyOptions): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ''} ${PADDLE_SCRIPT}`,
    `style-src 'self' 'unsafe-inline' ${paddleSandbox ? PADDLE_SANDBOX_CDN : PADDLE_SCRIPT}`,
    `img-src 'self' data: blob: https://avatars.githubusercontent.com https://*.googleusercontent.com ${BLOB_HOSTS}`,
    "font-src 'self'",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    `connect-src 'self' https://vercel.com ${BLOB_HOSTS} ${PADDLE_HOSTS}${dev ? ' ws:' : ''}`,
    `frame-src ${PADDLE_HOSTS}`,
    "form-action 'self' https://github.com https://accounts.google.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

/**
 * The kill switch: `CSP_REPORT_ONLY=1` sends the same policy as
 * Content-Security-Policy-Report-Only, so a violation the browser check
 * missed can be turned from a broken page into a console line by an
 * environment change and redeploy, without a code change. Next reads the
 * nonce from either header.
 */
export function policyHeaderName(env: Record<string, string | undefined> = process.env): 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only' {
  return env.CSP_REPORT_ONLY === '1' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
}

/** 128 random bits, base64, fresh for every request. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
