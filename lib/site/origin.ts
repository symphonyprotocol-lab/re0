/**
 * Where the public service lives.
 *
 * This is copy, not configuration: the connect snippets on the marketing pages
 * -- the prompt, the MCP endpoint, the REST sample -- tell a visitor which host
 * to point their client at, and that answer is the same wherever the page is
 * rendered from. A preview deployment or a laptop must not hand out its own
 * `APP_BASE_URL`, or the reader copies an address only the author can reach.
 *
 * Anything that has to address *this* deployment -- OAuth callbacks, session
 * cookies -- reads `APP_BASE_URL` instead, see `lib/http/session.ts`.
 */
export const PUBLIC_ORIGIN = 'https://re0.io';

/** The public URL of `path`, e.g. `publicUrl('/mcp')`. */
export function publicUrl(path: string): string {
  return `${PUBLIC_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}
