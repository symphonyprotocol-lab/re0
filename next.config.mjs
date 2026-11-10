/*
 * Response headers for every route (rebuild review M14): HSTS, no MIME
 * sniffing, a same-origin referrer, no framing by anyone (the console approves
 * payouts and KYC; nothing here is meant to be embedded) and no camera /
 * microphone / location.
 *
 * Content-Security-Policy: pages get theirs from middleware.ts, built per
 * request around a nonce (lib/http/csp.ts). Everything middleware skips --
 * API routes, `/media` blobs, Next's static files, public/ -- is never a
 * document, so it gets a policy that allows nothing. `CSP_REPORT_ONLY=1`
 * sends both as Report-Only instead (the kill switch; README "Security
 * headers").
 */
const POLICY_HEADER = process.env.CSP_REPORT_ONLY === '1' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
const NON_DOCUMENT_POLICY = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
/* Middleware's matcher, inverted: the paths it does not run on. */
const NON_DOCUMENT_PATHS = ['/api/:path*', '/media/:path*', '/_next/static/:path*', '/_next/image', '/video/:path*', '/favicon.ico'];

const SECURITY_HEADERS = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), usb=(), interest-cohort=()' },
];

/** @type {import('next').NextConfig} */
const config = {
  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      ...NON_DOCUMENT_PATHS.map((source) => ({ source, headers: [{ key: POLICY_HEADER, value: NON_DOCUMENT_POLICY }] })),
    ];
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
