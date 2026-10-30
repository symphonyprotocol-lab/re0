/**
 * Whether an A2A push-notification callback may be called
 * (agent-first-proposal.md 7.8, requirement.md 12 item 1).
 *
 * A callback URL is a URL a stranger typed that our server will POST to,
 * which is the same risk a source URL is, so it passes the same checks
 * (`assertFetchable`: https only, no credentials, no local or private
 * literal) -- at registration, and again before every send, because what a
 * name resolves to can change between the two. The second time the name is
 * also resolved and every address it returns is checked, which closes the
 * "public name, private address" gap the literal check leaves open; the send
 * itself never follows a redirect.
 */
import { lookup } from 'node:dns/promises';
import { assertFetchable, isPrivateV6, PRIVATE_V4 } from './http';

export class CallbackRefused extends Error {}

export type ResolveHost = (host: string) => Promise<string[]>;

const systemResolve: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/** Parses and checks the literal URL; throws `CallbackRefused` with the reason. */
export function parseCallbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CallbackRefused('the callback URL is not a URL');
  }
  try {
    assertFetchable(url);
  } catch (error) {
    throw new CallbackRefused(error instanceof Error ? error.message : 'the callback URL is not allowed');
  }
  return url;
}

/** The literal checks, then every address the host resolves to. */
export async function assertCallbackReachable(raw: string, resolve: ResolveHost = systemResolve): Promise<URL> {
  const url = parseCallbackUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  /* A literal address was judged above; there is nothing to resolve. */
  if (/^[\d.]+$/.test(host) || host.includes(':')) return url;
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new CallbackRefused('the callback host does not resolve');
  }
  if (addresses.length === 0) throw new CallbackRefused('the callback host does not resolve');
  for (const address of addresses) {
    if (PRIVATE_V4.test(address) || address === '0.0.0.0' || isPrivateV6(address.toLowerCase())) {
      throw new CallbackRefused('the callback host resolves to a private address');
    }
  }
  return url;
}
