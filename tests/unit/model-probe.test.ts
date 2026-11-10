import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelEndpoint } from '@/lib/infra/ai/models';

/** DNS for the names below; everything else resolves for real. */
const dns = vi.hoisted(() => ({ answers: new Map<string, { address: string; family: number }[]>() }));
vi.mock('node:dns', async (original) => {
  const real = await original<typeof import('node:dns')>();
  const lookup = ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const answer = dns.answers.get(hostname);
    if (answer) return callback(null, answer);
    return (real.lookup as (...args: unknown[]) => void)(hostname, options, callback);
  }) as typeof real.lookup;
  return { ...real, default: { ...real, lookup }, lookup };
});
/* Usage logging writes to the database; not under test here. */
vi.mock('@/lib/infra/ai/usage', async (original) => ({
  ...(await original<typeof import('@/lib/infra/ai/usage')>()),
  loggedLanguageModel: (model: unknown) => model,
  recordModelCall: async () => undefined,
}));

const { probeEndpoint } = await import('@/lib/infra/ai/probe');
const { parseModelConfig } = await import('@/lib/domain/models');

const SECRET = 'INTERNAL-SERVICE-SECRET-4f2a';
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    response.writeHead(request.url?.includes('unauthorized') ? 401 : 500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: SECRET }, secret: SECRET }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function endpoint(kind: ModelEndpoint['kind'], baseUrl: string): ModelEndpoint {
  return { kind, configId: null, name: 'probe', transport: 'openai_compatible', baseUrl, model: 'm', apiKey: 'k', timeoutMs: 5_000, source: 'console' };
}

describe('model endpoint probe', () => {
  it('reaches a private model host but never echoes the response body on failure', async () => {
    const transcription = await probeEndpoint(endpoint('transcription', `${base}/v1`));
    expect(transcription).toMatchObject({ ok: false, detail: 'HTTP 500 server error' });
    const generation = await probeEndpoint(endpoint('generation', `${base}/unauthorized/v1`));
    expect(generation).toMatchObject({ ok: false, detail: 'HTTP 401 unauthorized' });
    for (const result of [transcription, generation]) expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('refuses link-local and metadata addresses, by literal and by resolved name', async () => {
    dns.answers.set('models.example.com', [{ address: '169.254.169.254', family: 4 }]);
    for (const baseUrl of ['http://169.254.169.254/v1', 'http://[fd00:ec2::254]/v1', 'http://metadata.google.internal/v1', 'http://models.example.com/v1']) {
      for (const kind of ['transcription', 'generation'] as const) {
        expect(await probeEndpoint(endpoint(kind, baseUrl)), `${kind} ${baseUrl}`).toMatchObject({ ok: false, detail: 'blocked address: link-local or metadata service' });
      }
    }
  });

  it('refuses a metadata base URL when the configuration is saved; private hosts stay allowed', () => {
    const config = (baseUrl: string) => parseModelConfig({ name: 'n', kind: 'generation', transport: 'openai_compatible', baseUrl, model: 'm' });
    expect(config('http://169.254.169.254/v1')).toEqual({ error: 'base_url' });
    expect(config('http://metadata.google.internal/v1')).toEqual({ error: 'base_url' });
    expect(config('http://10.0.0.5:8000/v1')).not.toHaveProperty('error');
    expect(config('http://localhost:11434/v1')).not.toHaveProperty('error');
  });
});
