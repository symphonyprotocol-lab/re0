import { config } from 'zod';

/*
 * The enforced CSP has no 'unsafe-eval' (lib/http/csp.ts). Zod's fast path
 * probes for it with `Function("")` on its first parse; the probe is caught
 * and Zod falls back to the same validation without generated code, but the
 * browser still logs "Refused to evaluate a string as JavaScript" on every
 * page. Saying jitless up front skips the probe. Imported by the root
 * layout's client provider, so it runs before any schema in the browser;
 * the server (no CSP) keeps the fast path.
 */
if (typeof window !== 'undefined') config({ jitless: true });
