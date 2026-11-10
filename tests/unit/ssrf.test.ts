import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Agent } from 'undici';

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

const { isPublicAddress, publicOnlyDispatcher, publicOnlyLookup, isPrivateAddressFailure } = await import('@/lib/infra/connectors/address');
const { fetchBytes } = await import('@/lib/infra/connectors/http');

let server: Server;
let port: number;
let hits = 0;
beforeAll(async () => {
  server = createServer((_request, response) => {
    hits += 1;
    response.end('internal secret');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('isPublicAddress', () => {
  it('refuses private, loopback, link-local, CGNAT, metadata and mapped ranges', () => {
    for (const address of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.100.100.200', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '198.18.0.1', '::1', '::', 'fe80::1', 'fd00:ec2::254', 'fc00::1', '::ffff:127.0.0.1',
      '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '[::1]', 'example.com',
    ]) expect(isPublicAddress(address), address).toBe(false);
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:93.184.216.34', '[2606:4700:4700::1111]']) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });
});

describe('connect-time pinning', () => {
  it('refuses a name whose answers include a private address', async () => {
    const lookup = publicOnlyLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
    const error = await new Promise<unknown>((resolve) => lookup('mixed.example.com', {}, (failure) => resolve(failure)));
    expect(isPrivateAddressFailure(error)).toBe(true);
  });

  it('never opens a socket to a private answer, even for a public-looking name', async () => {
    /* A rebinding resolver answers 127.0.0.1 for the second lookup; the dispatcher checks the answer it dials. */
    const agent = new Agent({ connect: { lookup: publicOnlyLookup(async () => [{ address: '127.0.0.1', family: 4 }]) } });
    const failure = await fetch(`http://rebind.example.com:${port}/`, { dispatcher: agent } as RequestInit).catch((error: unknown) => error);
    expect(isPrivateAddressFailure(failure)).toBe(true);
    const direct = await fetch(`http://localhost:${port}/`, { dispatcher: publicOnlyDispatcher() } as RequestInit).catch((error: unknown) => error);
    expect(isPrivateAddressFailure(direct)).toBe(true);
    expect(hits).toBe(0);
    await agent.close();
  });

  it('fetchBytes refuses a public name that resolves privately', async () => {
    dns.answers.set('intranet.example.com', [{ address: '169.254.169.254', family: 4 }]);
    await expect(fetchBytes('http://intranet.example.com/latest/meta-data/')).rejects.toMatchObject({ code: 'source_forbidden' });
  });

  it('fetchBytes refuses non-standard ports, other schemes and private literals', async () => {
    for (const url of [`http://example.com:${port}/`, 'http://example.com:22/', 'ftp://example.com/', 'http://[::ffff:7f00:1]/', 'http://0x7f.1/', 'http://169.254.169.254/']) {
      await expect(fetchBytes(url), url).rejects.toMatchObject({ code: 'source_forbidden' });
    }
  });
});
