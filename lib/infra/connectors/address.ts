/**
 * The resolution half of SSRF defence. `isPublicHost` refuses private names
 * and literals before a request; this refuses a public-looking name whose
 * DNS answer is private, at the moment the socket connects, so the address
 * checked is the address dialled (a rebinding resolver gets no second
 * answer: the connection uses the one this lookup returned).
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

/** Not the public internet: loopback, private, CGNAT, link-local (cloud metadata), documentation, multicast, reserved. */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128],
  /* NAT64, discard, Teredo, documentation, 6to4: each can carry or reach a v4 address we cannot vouch for. */
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) BLOCKED.addSubnet(network, prefix, 'ipv6');

/** A v4 address written as v6 (`::ffff:a.b.c.d`, `::a.b.c.d`, or hex), as dotted v4; else null. */
function embeddedV4(address: string): string | null {
  const lower = address.toLowerCase();
  const match = /^::(?:ffff:(?:0:)?)?(.+)$/.exec(lower);
  if (!match) return null;
  const tail = match[1]!;
  if (isIP(tail) === 4) return tail;
  const parts = tail.split(':');
  if (parts.length !== 2 || !parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null;
  const [hi, lo] = parts.map((part) => Number.parseInt(part, 16)) as [number, number];
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Whether an IP literal (v4 or v6, brackets allowed) is on the public internet. Anything that is not an IP is not. */
export function isPublicAddress(raw: string): boolean {
  const address = raw.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, 'ipv4');
  if (family !== 6) return false;
  const v4 = embeddedV4(address);
  if (v4) return !BLOCKED.check(v4, 'ipv4');
  return !BLOCKED.check(address, 'ipv6');
}

export class PrivateAddressError extends Error {
  readonly code = 'EPRIVATEADDRESS';
  constructor(host: string, address: string) {
    super(`${host} resolves to ${address}, which is not a public address`);
  }
}

/**
 * Link-local and cloud metadata addresses: the instance's own credentials
 * live there. Private ranges are not in this list on purpose (a model server
 * on a private network is a legitimate endpoint); these never are.
 */
const METADATA = new BlockList();
METADATA.addSubnet('169.254.0.0', 16, 'ipv4');
/* Alibaba Cloud's metadata service sits in CGNAT space. */
METADATA.addAddress('100.100.100.200', 'ipv4');
METADATA.addSubnet('fe80::', 10, 'ipv6');
/* AWS's IPv6 instance metadata endpoint. */
METADATA.addAddress('fd00:ec2::254', 'ipv6');
const METADATA_NAMES = new Set(['metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data', 'instance-data.ec2.internal']);

/** Whether an IP literal is link-local or a cloud metadata address. */
export function isMetadataAddress(raw: string): boolean {
  const address = raw.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(address);
  if (family === 4) return METADATA.check(address, 'ipv4');
  if (family !== 6) return false;
  const v4 = embeddedV4(address);
  if (v4) return METADATA.check(v4, 'ipv4');
  return METADATA.check(address, 'ipv6');
}

/** Whether a hostname is a metadata service by name. */
export function isMetadataName(hostname: string): boolean {
  return METADATA_NAMES.has(hostname.toLowerCase().replace(/\.+$/, ''));
}

type Resolve = (hostname: string) => Promise<LookupAddress[]>;

const systemResolve: Resolve = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))));

/**
 * A `net.connect` lookup that resolves once, refuses the host if any answer
 * is private, and hands back only the answers it checked.
 */
export function publicOnlyLookup(resolve: Resolve = systemResolve): LookupFunction {
  return checkedLookup(isPublicAddress, resolve);
}

/** A `net.connect` lookup that resolves once and refuses the host unless every answer passes `allowed`. */
export function checkedLookup(allowed: (address: string) => boolean, resolve: Resolve = systemResolve): LookupFunction {
  return (hostname, options, callback) => {
    if (isMetadataName(hostname)) return callback(new PrivateAddressError(hostname, hostname), '', 0);
    resolve(hostname).then(
      (addresses) => {
        const wanted = options.family === 4 || options.family === 6 ? addresses.filter((entry) => entry.family === options.family) : addresses;
        const blocked = addresses.find((entry) => !allowed(entry.address));
        if (blocked) return callback(new PrivateAddressError(hostname, blocked.address), '', 0);
        if (!wanted.length) return callback(Object.assign(new Error(`${hostname} has no address`), { code: 'ENOTFOUND' }), '', 0);
        if (options.all) return (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, wanted);
        return callback(null, wanted[0]!.address, wanted[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, '', 0),
    );
  };
}

let shared: Agent | null = null;

/** The dispatcher every fetch of an owner-supplied URL goes through. */
export function publicOnlyDispatcher(): Agent {
  shared ??= new Agent({ connect: { lookup: publicOnlyLookup() } });
  return shared;
}

let models: Agent | null = null;

/**
 * For administrator-configured model endpoints: private hosts are allowed,
 * link-local and metadata addresses are not, checked on the address dialled.
 */
export function modelEndpointDispatcher(): Agent {
  models ??= new Agent({ connect: { lookup: checkedLookup((address) => !isMetadataAddress(address)) } });
  return models;
}

/**
 * `fetch` for a model endpoint. An IP literal never reaches a lookup, so it
 * is checked here; a name is checked at connect time by the dispatcher.
 */
export const modelFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (isMetadataAddress(url.hostname) || isMetadataName(url.hostname)) {
    throw new TypeError('fetch failed', { cause: new PrivateAddressError(url.hostname, url.hostname) });
  }
  return fetch(input, { ...init, dispatcher: modelEndpointDispatcher() } as RequestInit);
};

/** Whether a failed fetch was refused by `publicOnlyLookup` (fetch wraps it as `cause`, sometimes twice). */
export function isPrivateAddressFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if (current instanceof PrivateAddressError || (current as { code?: string }).code === 'EPRIVATEADDRESS') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
