/**
 * Authenticated encryption for values the server hands to a browser and
 * expects back unchanged: the OAuth and GitHub-connect handshake cookies, the
 * console's first-run and enrolment TOTP secrets, and administrator invite
 * links. AES-GCM under a key derived from AUTH_SECRET.
 *
 * Every ticket is bound to its purpose: the purpose is the AES-GCM additional
 * authenticated data, so a ticket sealed for one use fails to open as any
 * other, whatever its payload says (`v2.` tickets).
 *
 * Tickets from before purposes (`iv.data`, no AAD) open only where the caller
 * passes `legacy`, a check that the payload is that kind of ticket; each such
 * kind carries its own expiry (seven days at most), after which the fallback
 * can go.
 */
import { base64UrlDecode, base64UrlEncode } from '@/lib/infra/crypto/tokens';
import { authSecret } from '@/lib/infra/crypto/secrets';

export type SealPurpose = 'oauth-handshake' | 'github-connect' | 'admin-bootstrap-totp' | 'admin-enrol-totp' | 'admin-invite';

const VERSION = 'v2';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedKey: Promise<CryptoKey> | undefined;

function sealKey(): Promise<CryptoKey> {
  cachedKey ??= (async () => {
    const material = await crypto.subtle.importKey('raw', encoder.encode(authSecret()), 'HKDF', false, [
      'deriveKey',
    ]);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode('re0/cookie-seal/v1'),
        info: encoder.encode('aes-gcm'),
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  })();
  return cachedKey;
}

const associatedData = (purpose: SealPurpose): Uint8Array<ArrayBuffer> => encoder.encode(`re0/seal/${purpose}`);

export async function seal(purpose: SealPurpose, payload: unknown): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData(purpose) },
    await sealKey(),
    encoder.encode(JSON.stringify(payload)),
  );
  return `${VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

async function open(iv: string, data: string, additionalData?: Uint8Array<ArrayBuffer>): Promise<unknown> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      additionalData ? { name: 'AES-GCM', iv: base64UrlDecode(iv), additionalData } : { name: 'AES-GCM', iv: base64UrlDecode(iv) },
      await sealKey(),
      base64UrlDecode(data),
    );
    return JSON.parse(decoder.decode(plaintext)) as unknown;
  } catch {
    return null;
  }
}

/** Null for anything tampered with, sealed for another purpose, or under another key. */
export async function unseal<T>(purpose: SealPurpose, value: string | undefined | null, legacy?: (payload: unknown) => boolean): Promise<T | null> {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length === 3 && parts[0] === VERSION && parts[1] && parts[2]) return (await open(parts[1], parts[2], associatedData(purpose))) as T | null;
  if (parts.length === 2 && parts[0] && parts[1] && legacy) {
    const payload = await open(parts[0], parts[1]);
    return payload !== null && legacy(payload) ? (payload as T) : null;
  }
  return null;
}
