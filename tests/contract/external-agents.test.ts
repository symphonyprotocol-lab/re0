/**
 * P4's rules without a database (agent-first-proposal.md 7.9): which Agent
 * Card URLs and interfaces re0 accepts, how a credential is put on a request
 * and shown again, that a private or loopback card address is refused before
 * any request leaves, that the outbound fetch follows no redirect and caps
 * what it reads, and that an agent credential is sealed under its own key.
 * tests/integration/agent-p4.test.ts runs the registry and the delegation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  cardRequiresCredential,
  credentialHeader,
  credentialValue,
  ExternalAgentRefused,
  isCredentialShaped,
  isTerminalRemoteState,
  maskedSuffix,
  normalizeCardUrl,
  schemeSnapshots,
  usableEndpoints,
} from '@/lib/domain/external-agent';
import { fetchAgentCard } from '@/lib/application/external-agents/registry';
import { guardedFetch, setExternalAgentTransport } from '@/lib/application/external-agents/transport';
import { forgetCredentialKey, openCredential, sealCredential } from '@/lib/infrastructure/crypto/credentials';

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExternalAgentRefused) return error.code;
    return (error as Error).message;
  }
  return 'resolved';
}

afterEach(() => setExternalAgentTransport());

describe('card URLs', () => {
  it('are https, without credentials, and a bare origin means the well-known path', () => {
    expect(normalizeCardUrl('agent.example.test')).toBe('https://agent.example.test/.well-known/agent-card.json');
    expect(normalizeCardUrl('https://agent.example.test/')).toBe('https://agent.example.test/.well-known/agent-card.json');
    expect(normalizeCardUrl('https://agent.example.test/cards/cal.json#x')).toBe('https://agent.example.test/cards/cal.json');
    expect(normalizeCardUrl('http://agent.example.test/card.json')).toBeNull();
    expect(normalizeCardUrl('https://user:pw@agent.example.test/card.json')).toBeNull();
    expect(normalizeCardUrl('')).toBeNull();
  });
});

describe('a card at a private or loopback address', () => {
  it('is refused before any request leaves, by literal and by what the name resolves to', async () => {
    let requests = 0;
    setExternalAgentTransport({
      fetch: async () => {
        requests += 1;
        return new Response('{}');
      },
      resolve: async (host) => (host === 'internal.example.test' ? ['10.0.0.7'] : host === 'six.example.test' ? ['fe80::1'] : ['93.184.216.34']),
    });
    for (const url of [
      'https://127.0.0.1/.well-known/agent-card.json',
      'https://localhost/card.json',
      'https://[::1]/card.json',
      'https://169.254.169.254/latest/meta-data',
      'https://192.168.1.10/card.json',
      'https://[::ffff:127.0.0.1]/card.json',
      'https://internal.example.test/card.json',
      'https://six.example.test/card.json',
    ]) {
      expect([url, await refusal(fetchAgentCard(url))]).toEqual([url, 'forbidden_address']);
    }
    expect(await refusal(fetchAgentCard('http://agent.example.test/card.json'))).toBe('invalid_url');
    expect(requests).toBe(0);
  });

  it('refuses a public card whose interfaces point inside', async () => {
    const card = {
      name: 'Sneaky',
      description: '',
      version: '1',
      supportedInterfaces: [{ url: 'https://127.0.0.1/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: {},
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    };
    setExternalAgentTransport({
      fetch: async () => new Response(JSON.stringify(card), { headers: { 'content-type': 'application/json' } }),
      resolve: async () => ['93.184.216.34'],
    });
    expect(await refusal(fetchAgentCard('https://agent.example.test/card.json'))).toBe('forbidden_address');
  });
});

describe('the outbound fetch', () => {
  it('follows no redirect and caps what it reads', async () => {
    setExternalAgentTransport({
      fetch: async (input) =>
        String(input).endsWith('/moved')
          ? new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/' } })
          : new Response('x'.repeat(2_000)),
      resolve: async () => ['93.184.216.34'],
    });
    const fetcher = guardedFetch({ timeoutMs: 1_000, maxBytes: 1_000 });
    expect(await refusal(fetcher('https://agent.example.test/moved'))).toBe('redirected');
    expect(await refusal(fetcher('https://agent.example.test/big'))).toBe('too_large');
  });

  it('keeps the method and body of a Request it is handed', async () => {
    const seen: { method?: string; body?: string }[] = [];
    setExternalAgentTransport({
      fetch: async (_input, init) => {
        seen.push({ method: init?.method, body: init?.body ? new TextDecoder().decode(init.body as ArrayBuffer) : undefined });
        return new Response('{}');
      },
      resolve: async () => ['93.184.216.34'],
    });
    await guardedFetch({ timeoutMs: 1_000, maxBytes: 1_000 })(new Request('https://agent.example.test/a2a', { method: 'POST', body: '{"a":1}' }));
    expect(seen[0]).toEqual({ method: 'POST', body: '{"a":1}' });
  });

  it('puts the credential header on the request, over anything the SDK set', async () => {
    const seen: Headers[] = [];
    setExternalAgentTransport({
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers));
        return new Response('{}');
      },
      resolve: async () => ['93.184.216.34'],
    });
    await guardedFetch({ timeoutMs: 1_000, maxBytes: 1_000, headers: { Authorization: 'Bearer secret-token-1234' } })(
      'https://agent.example.test/a2a',
      { headers: { authorization: 'Bearer something-else', 'content-type': 'application/json' } },
    );
    expect(seen[0]!.get('authorization')).toBe('Bearer secret-token-1234');
    expect(seen[0]!.get('content-type')).toBe('application/json');
  });
});

describe('interfaces', () => {
  it('keep JSON-RPC and HTTP+JSON on A2A 1.0 or 0.3, preferring 1.0 and JSON-RPC, and drop gRPC', () => {
    const endpoints = usableEndpoints([
      { url: 'https://a.example.test/grpc', protocolBinding: 'GRPC', protocolVersion: '1.0' },
      { url: 'https://a.example.test/rest03', protocolBinding: 'HTTP+JSON', protocolVersion: '0.3' },
      { url: 'https://a.example.test/rest', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' },
      { url: 'https://a.example.test/rpc03', protocolBinding: 'JSONRPC', protocolVersion: '0.3.0' },
      { url: 'https://a.example.test/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: 'http://a.example.test/plain', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: 'https://a.example.test/future', protocolBinding: 'JSONRPC', protocolVersion: '2.0' },
    ]);
    expect(endpoints.map((endpoint) => endpoint.url)).toEqual([
      'https://a.example.test/rpc',
      'https://a.example.test/rest',
      'https://a.example.test/rpc03',
      'https://a.example.test/rest03',
    ]);
  });
});

describe('credentials', () => {
  const schemes = schemeSnapshots({
    bearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { scheme: 'Bearer' } } },
    key: { scheme: { $case: 'apiKeySecurityScheme', value: { location: 'header', name: 'X-Cal-Key' } } },
    query: { scheme: { $case: 'apiKeySecurityScheme', value: { location: 'query', name: 'key' } } },
    oauth: { scheme: { $case: 'oauth2SecurityScheme', value: {} } },
  });

  it('go in Authorization as a bearer, or in the header the card names for an API key', () => {
    expect(schemes.bearer).toEqual({ kind: 'bearer' });
    expect(schemes.key).toEqual({ kind: 'api_key', header: 'X-Cal-Key' });
    expect(schemes.query?.kind).toBe('unsupported');
    expect(schemes.oauth?.kind).toBe('unsupported');
    expect(credentialHeader('bearer', schemes)).toBe('Authorization');
    expect(credentialHeader('api_key', schemes)).toBe('X-Cal-Key');
    expect(credentialHeader('api_key', {})).toBe('X-API-Key');
    expect(credentialHeader('api_key', { k: { kind: 'api_key', header: 'Host' } })).toBe('X-API-Key');
    expect(credentialValue('bearer', 'tok-123456789')).toBe('Bearer tok-123456789');
    expect(credentialValue('api_key', 'tok-123456789')).toBe('tok-123456789');
  });

  it('are shown again only by their last four characters, and only when long enough to spare them', () => {
    expect(maskedSuffix('sk-live-0123456789abcd')).toBe('abcd');
    expect(maskedSuffix('short-tok')).toBeNull();
  });

  it('are printable, without spaces or line breaks', () => {
    expect(isCredentialShaped('sk-live-0123456789')).toBe(true);
    expect(isCredentialShaped('two words here')).toBe(false);
    expect(isCredentialShaped('token\r\nX-Injected: 1')).toBe(false);
    expect(isCredentialShaped('short')).toBe(false);
  });

  it('are sealed under a key of their own: an agent credential does not open as a provider key', async () => {
    const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'c'.repeat(48);
    forgetCredentialKey();
    try {
      const sealed = await sealCredential('sk-agent-0123456789', 'agent');
      expect(sealed).not.toContain('sk-agent');
      expect(await openCredential(sealed, 'agent')).toBe('sk-agent-0123456789');
      expect(await openCredential(sealed)).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      else process.env.CREDENTIAL_ENCRYPTION_KEY = saved;
      forgetCredentialKey();
    }
  });
});

describe('whether a card requires a credential', () => {
  it('follows its security requirements: none, or one naming no scheme, means anonymous is allowed', () => {
    expect(cardRequiresCredential([['bearer']])).toBe(true);
    expect(cardRequiresCredential([['bearer'], ['key']])).toBe(true);
    expect(cardRequiresCredential([])).toBe(false);
    expect(cardRequiresCredential([['bearer'], []])).toBe(false);
  });
});

describe('remote states', () => {
  it('treat a reply message and an undelivered send as final', () => {
    expect(isTerminalRemoteState('MESSAGE')).toBe(true);
    expect(isTerminalRemoteState('SEND_FAILED')).toBe(true);
    expect(isTerminalRemoteState('TASK_STATE_COMPLETED')).toBe(true);
    expect(isTerminalRemoteState('TASK_STATE_WORKING')).toBe(false);
    expect(isTerminalRemoteState('TASK_STATE_INPUT_REQUIRED')).toBe(false);
  });
});
