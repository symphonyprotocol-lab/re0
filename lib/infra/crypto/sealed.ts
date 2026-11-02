/**
 * Authenticated encryption for values the server hands to a browser and
 * expects back unchanged: the OAuth handshake cookie and the console's
 * first-run TOTP secret. AES-GCM under a key derived from AUTH_SECRET.
 */
import { base64UrlDecode, base64UrlEncode } from '@/lib/infra/crypto/tokens';
import { authSecret } from '@/lib/infra/crypto/secrets';

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

export async function seal(payload: unknown): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await sealKey(),
    encoder.encode(JSON.stringify(payload)),
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

/** Null for anything tampered with, expired keys included. */
export async function unseal<T>(value: string | undefined | null): Promise<T | null> {
  if (!value) return null;
  const [ivPart, dataPart] = value.split('.');
  if (!ivPart || !dataPart) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(ivPart) },
      await sealKey(),
      base64UrlDecode(dataPart),
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    return null;
  }
}
