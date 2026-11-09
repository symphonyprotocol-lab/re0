/** @type {import('next').NextConfig} */
const config = {
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
