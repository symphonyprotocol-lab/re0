/**
 * Surfaces taken offline by the agent-first turn (agent-first-proposal.md
 * 3.6): the website widget, the shared pages and the remote MCP endpoint.
 * Channels, Agent Cards and A2A replace them as the ways out of the product.
 *
 * "暂时下线" -- the entrances and routes are withdrawn, the code stays behind
 * these switches rather than being deleted, because the decision to bring a
 * surface back (or to delete it for good) is a product call that has not been
 * made. Everything that served one of them checks here first: a page calls
 * `notFound()`, a Route Handler answers 404, a navigation rail leaves the
 * entry out. The switches are constants, not environment variables, so a
 * deployment cannot quietly re-open a surface the product has closed.
 */

export const RETIRED_SURFACES = ['widget', 'showcase', 'mcp'] as const;

export type RetiredSurface = (typeof RETIRED_SURFACES)[number];

const ENABLED: Readonly<Record<RetiredSurface, boolean>> = {
  widget: false,
  showcase: false,
  mcp: false,
};

export function surfaceEnabled(surface: RetiredSurface): boolean {
  return ENABLED[surface];
}
