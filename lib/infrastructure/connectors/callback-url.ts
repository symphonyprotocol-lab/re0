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
 *
 * The resolve has a deadline of its own. The name is a stranger's, and so is
 * its name server: one that never answers must not hold a send -- or, with
 * `getaddrinfo`, one of the four libuv threads every other request shares --
 * for as long as the operating system cares to wait. So names go to c-ares
 * (`Resolver`, off the thread pool) with a bounded timeout, and the whole
 * resolve is raced against the caller's deadline as well.
 */
import { Resolver } from 'node:dns/promises';
import { assertFetchable, isPrivateV6, PRIVATE_V4 } from './http';

export class CallbackRefused extends Error {}

export type ResolveHost = (host: string) => Promise<string[]>;

/** How long a name may take to resolve, unless the caller's own deadline is shorter. */
export const RESOLVE_TIMEOUT_MS = 2_000;

const systemResolve: ResolveHost = async (host) => {
  const resolver = new Resolver({ timeout: RESOLVE_TIMEOUT_MS, tries: 1 });
  /* Both families: a name with only AAAA records is a name, and every address it has is checked. */
  const answers = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  const addresses = answers.flatMap((answer) => (answer.status === 'fulfilled' ? answer.value : []));
  if (addresses.length === 0 && answers.every((answer) => answer.status === 'rejected')) {
    throw (answers[0] as PromiseRejectedResult).reason;
  }
  return addresses;
};

/** The resolve, or a refusal when it outlasts the timeout or the caller's signal fires first. */
async function resolveWithin(resolve: ResolveHost, host: string, timeoutMs: number, signal?: AbortSignal): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    const refuse = () => reject(new CallbackRefused('the callback host did not resolve in time'));
    if (signal?.aborted) return refuse();
    timer = setTimeout(refuse, timeoutMs);
    onAbort = refuse;
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([resolve(host), deadline]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

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

/**
 * The literal checks, then every address the host resolves to -- within
 * `timeoutMs`, or sooner if `signal` fires (a send's own deadline).
 */
export async function assertCallbackReachable(
  raw: string,
  resolve: ResolveHost = systemResolve,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<URL> {
  const url = parseCallbackUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  /* A literal address was judged above; there is nothing to resolve. */
  if (/^[\d.]+$/.test(host) || host.includes(':')) return url;
  let addresses: string[];
  try {
    addresses = await resolveWithin(resolve, host, options.timeoutMs ?? RESOLVE_TIMEOUT_MS, options.signal);
  } catch (error) {
    if (error instanceof CallbackRefused) throw error;
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
