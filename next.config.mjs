/*
 * Response headers for every route (rebuild review M14). Enforced: HSTS,
 * no MIME sniffing, a same-origin referrer, no framing by anyone (the
 * console approves payouts and KYC; nothing here is meant to be embedded),
 * no plugins, no <base> hijack, and no camera / microphone / location.
 *
 * The full content policy is Report-Only for now: Next.js App Router inlines
 * its bootstrap scripts (no nonce pipeline here), Paddle checkout loads
 * cdn.paddle.com and frames buy.paddle.com, Remotion's in-browser export uses
 * WebAssembly, workers and blob: media, and avatars may be OAuth photos.
 * Browsers log violations to the console; once a release shows none, move
 * CONTENT_POLICY to `content-security-policy`.
 */
const dev = process.env.NODE_ENV !== 'production';
const CONTENT_POLICY = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ''} https://cdn.paddle.com`,
  "style-src 'self' 'unsafe-inline' https://cdn.paddle.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  `connect-src 'self' https://vercel.com https://*.blob.vercel-storage.com https://*.paddle.com${dev ? ' ws:' : ''}`,
  'frame-src https://*.paddle.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self' https://github.com https://accounts.google.com",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: 'Content-Security-Policy-Report-Only', value: CONTENT_POLICY },
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
