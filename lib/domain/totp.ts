/**
 * TOTP (RFC 6238) on WebCrypto only.
 *
 * The console requires a second factor (rebuild-proposal.md 2.5), and an
 * authenticator app is the one form that needs no delivery channel and no
 * third-party dependency. HMAC-SHA1 is what RFC 4226 specifies and what every
 * authenticator implements; it is a MAC over a counter here, not a hash over a
 * secret, so SHA-1's collision weakness does not apply.
 */
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 30 seconds, the step every authenticator app assumes. */
export const TOTP_STEP_SECONDS = 30;
/** One step either side, to absorb clock drift between server and phone. */
export const TOTP_WINDOW = 1;
export const TOTP_DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

/** Returns null for anything that is not valid base32; never throws. */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> | null {
  const cleaned = input.replaceAll('=', '').replaceAll(' ', '').toUpperCase();
  if (cleaned.length === 0) return null;

  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of cleaned) {
    const index = BASE32.indexOf(character);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}

/** 160 bits, the secret size RFC 4226 recommends for HMAC-SHA1. */
export function randomTotpSecret(bytes = 20): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base32Encode(buffer);
}

async function codeForCounter(
  secret: Uint8Array<ArrayBuffer>,
  counter: number,
): Promise<string> {
  const message = new Uint8Array(8);
  // Counters stay well inside 2^53, so the high word is derived by division.
  let high = Math.floor(counter / 2 ** 32);
  let low = counter >>> 0;
  for (let i = 3; i >= 0; i -= 1) {
    message[i] = high & 0xff;
    high >>>= 8;
    message[i + 4] = low & 0xff;
    low >>>= 8;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));

  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

export function totpCounter(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/**
 * The TOTP step `code` is valid for at `now`, or null.
 *
 * `minCounter` refuses a step that has already been spent, which is what stops
 * an observed code being replayed inside its own validity window
 * (RFC 6238 5.2) -- without it a code stays usable for the full step plus the
 * drift window either side.
 *
 * Every candidate step is compared even after a match, so the answer's timing
 * does not reveal which step matched.
 */
export async function verifyTotpCounter(
  secretBase32: string,
  code: string,
  now: Date = new Date(),
  options: { window?: number; minCounter?: number | null } = {},
): Promise<number | null> {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return null;

  const secret = base32Decode(secretBase32);
  if (!secret || secret.length === 0) return null;

  const window = options.window ?? TOTP_WINDOW;
  const minCounter = options.minCounter ?? null;
  const counter = totpCounter(now);

  let matched: number | null = null;
  for (let drift = -window; drift <= window; drift += 1) {
    const candidate = counter + drift;
    const spent = minCounter !== null && candidate <= minCounter;
    const equal = timingSafeEqual(await codeForCounter(secret, candidate), trimmed);
    if (equal && !spent && matched === null) matched = candidate;
  }
  return matched;
}

/** Boolean form, for callers with no replay window to enforce. */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  now: Date = new Date(),
  window: number = TOTP_WINDOW,
): Promise<boolean> {
  return (await verifyTotpCounter(secretBase32, code, now, { window })) !== null;
}

/** `otpauth://` URI an authenticator app can be pointed at. */
export function totpProvisioningUri(input: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
