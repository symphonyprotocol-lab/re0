/**
 * The outside web for integration tests: `fetch` to the hosts named here is
 * answered by handlers; everything else (the fake model endpoint on
 * 127.0.0.1) goes through. Handlers see the request's headers, so a private
 * GitHub repository can answer 404 anonymously and 200 with a token.
 */
import { vi } from 'vitest';

export type WebHandler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

export interface FakeWeb {
  /** Routes by `host + pathname` (and `?query` when the key has one). */
  routes: Map<string, WebHandler>;
  requests: string[];
  restore(): void;
}

export function startFakeWeb(hosts: readonly string[]): FakeWeb {
  const original = globalThis.fetch;
  const routes = new Map<string, WebHandler>();
  const requests: string[] = [];
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!hosts.includes(url.hostname)) return original(input, init);
    requests.push(url.href);
    const handler = routes.get(`${url.host}${url.pathname}${url.search}`) ?? routes.get(`${url.host}${url.pathname}`);
    if (!handler) return new Response('not found', { status: 404 });
    return handler(url, init);
  });
  vi.stubGlobal('fetch', stub);
  return { routes, requests, restore: () => vi.stubGlobal('fetch', original) };
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export function text(body: string, type = 'text/plain'): Response {
  return new Response(body, { headers: { 'content-type': type } });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function authorization(init: RequestInit | undefined): string | null {
  const headers = new Headers(init?.headers);
  return headers.get('authorization');
}
