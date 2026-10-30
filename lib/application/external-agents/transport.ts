/**
 * The only way re0 reaches an external A2A Agent (agent-first-proposal.md
 * 7.9): fetching its card, and every SendMessage, GetTask and CancelTask
 * after that.
 *
 * Each request is a request to a URL a user typed or a stranger's card
 * named, so each one passes the push-callback checks first
 * (callback-url.ts: https, no credentials in the URL, no local or private
 * literal, then every address the host resolves to) -- on every request,
 * not once at registration, because what a name resolves to can change.
 * Redirects are not followed: a 3xx is a refusal, since following one would
 * carry the user's credential to a host nobody checked. The response is
 * read whole and capped; nothing here logs a URL's query, a header or a
 * body.
 */
import { assertCallbackReachable, CallbackRefused, type ResolveHost } from '@/lib/infrastructure/connectors/callback-url';
import { ExternalAgentRefused } from '@/lib/domain/external-agent';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Transport {
  fetch: FetchLike;
  resolve: ResolveHost | undefined;
}

const DEFAULT: Transport = { fetch: (input, init) => fetch(input, init), resolve: undefined };
let transport: Transport = DEFAULT;

/** Test seam: a mocked external Agent and resolver. Call with no argument to restore the network. */
export function setExternalAgentTransport(override?: Partial<Transport>): void {
  transport = override ? { ...DEFAULT, ...override } : DEFAULT;
}

/** Throws `ExternalAgentRefused('forbidden_address')` for a URL re0 must not call. */
export async function assertAgentAddress(raw: string): Promise<URL> {
  try {
    return await assertCallbackReachable(raw, transport.resolve);
  } catch (error) {
    if (error instanceof CallbackRefused) {
      throw new ExternalAgentRefused('forbidden_address', error.message.replace('callback', 'agent'));
    }
    throw error;
  }
}

/**
 * A `fetch` for the SDK's transports and the card fetch: checked, no
 * redirects, a deadline, a size cap, and the given headers added. Headers
 * the SDK set are kept; the credential header, if any, is ours and wins.
 */
export function guardedFetch(options: { timeoutMs: number; maxBytes: number; headers?: Record<string, string> }): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    await assertAgentAddress(url);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    let response: Response;
    try {
      response = await transport.fetch(url, {
        ...init,
        headers,
        redirect: 'manual',
        signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof ExternalAgentRefused) throw error;
      throw new ExternalAgentRefused('unreachable', 'the agent did not answer');
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ExternalAgentRefused('redirected', 'the agent answered with a redirect, which re0 does not follow');
    }
    const body = await readCapped(response, options.maxBytes);
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ExternalAgentRefused('too_large', 'the agent’s answer is too large');
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ExternalAgentRefused('too_large', 'the agent’s answer is too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
