/*
 * Response headers for every route (rebuild review M14).
 *
 * Enforced: HSTS, no MIME sniffing, a same-origin referrer, no framing by
 * anyone (the console approves payouts and KYC; nothing here is meant to be
 * embedded), no plugins, no <base> hijack, images only over https / data: /
 * blob: or same-origin, http subresources upgraded in production, and no
 * camera / microphone / location.
 *
 * Report-Only (logged to the browser console, nothing blocked): scripts,
 * styles, fonts, media, workers, connections, frames and form targets. Next.js
 * App Router inlines its bootstrap scripts (there is no nonce pipeline),
 * Paddle checkout loads cdn.paddle.com and frames buy.paddle.com, Remotion's
 * in-browser export uses WebAssembly, workers and blob: media, and the OAuth
 * buttons post to a route that redirects to GitHub / Google. Steps before
 * enforcing are in PR #105's description; in short, run each flow on a
 * production build with the console open and see no
 * "[Report Only] Refused to ..." line.
 */
const dev = process.env.NODE_ENV !== 'production';
const ENFORCED_POLICY = [
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  `img-src 'self' data: blob: https:${dev ? ' http:' : ''}`,
  ...(dev ? [] : ['upgrade-insecure-requests']),
].join('; ');
const REPORTED_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ''} https://cdn.paddle.com`,
  "style-src 'self' 'unsafe-inline' https://cdn.paddle.com",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  `connect-src 'self' https://vercel.com https://*.blob.vercel-storage.com https://*.paddle.com${dev ? ' ws:' : ''}`,
  'frame-src https://*.paddle.com',
  "form-action 'self' https://github.com https://accounts.google.com",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: ENFORCED_POLICY },
  { key: 'Content-Security-Policy-Report-Only', value: REPORTED_POLICY },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), usb=(), interest-cohort=()' },
];

/** @type {import('next').NextConfig} */
const config = {
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  reactStrictMode: true,
  serverExternalPackages: ['@neondatabase/serverless'],
  /*
   * pdf.js reads its predefined CMaps (non-embedded CJK fonts) and standard
   * font data from disk at runtime (lib/infra/connectors/pdf.ts), so the
   * routes that process documents ship those folders with them.
   */
  outputFileTracingIncludes: {
    '/api/rees/*/knowledge{,/**}': ['./node_modules/pdfjs-dist/cmaps/**/*', './node_modules/pdfjs-dist/standard_fonts/**/*'],
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
    ],
  },
};

export default config;
