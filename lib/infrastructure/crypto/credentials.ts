/**
 * Provider credentials at rest: AES-256-GCM with a key derived from
 * `CREDENTIAL_ENCRYPTION_KEY`.
 *
 * The model registry holds the key a console operator typed, not the name of
 * an environment variable holding it (architecture.md 15.3): one installation
 * runs four kinds of model from as many providers, and a deployment that has
 * to be redeployed to change one of them is a console that only looks like it
 * configures anything.
 *
 * A column of plaintext keys would make the registry worth as much as the
 * provider accounts behind it, so nothing is written in the clear. GCM rather
 * than a bare cipher: the tag is what makes a row that was tampered with fail
 * to open instead of decrypting into a key that goes out over HTTP.
 *
 * Its own secret, separate from `SESSION_SIGNING_SECRET`: rotating the session
 * secret signs everyone out, and nobody should have to weigh that against
 * leaving provider credentials under a key they want to retire.
 */
import { base64UrlDecode, base64UrlEncode } from '@/lib/infrastructure/crypto/tokens';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let cachedKey: Promise<CryptoKey> | undefined;

function encryptionSecret(): string {
  const secret = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is not set (needs at least 32 characters)');
  }
  return secret;
}

export function isCredentialKeyConfigured(): boolean {
  const secret = process.env.CREDENTIAL_ENCRYPTION_KEY;
  return Boolean(secret && secret.length >= 32);
}

function credentialKey(): Promise<CryptoKey> {
  cachedKey ??= (async () => {
    const material = await crypto.subtle.importKey(
      'raw',
      encoder.encode(encryptionSecret()),
      'HKDF',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode('re0/provider-credential/v1'),
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

/** The stored form: a fresh nonce and the sealed key, both base64url. */
export async function sealCredential(plaintext: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await credentialKey(),
    encoder.encode(plaintext),
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

/**
 * Null rather than a throw when a row cannot be opened -- a credential sealed
 * under a retired secret is a configuration problem the caller reports as an
 * unavailable provider, not a crash on the retrieval path.
 */
export async function openCredential(sealed: string | null | undefined): Promise<string | null> {
  if (!sealed) return null;
  const [nonce, body] = sealed.split('.');
  if (!nonce || !body) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(nonce) },
      await credentialKey(),
      base64UrlDecode(body),
    );
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}

/** Test seam: the derived key is cached, and a test changes the secret. */
export function forgetCredentialKey(): void {
  cachedKey = undefined;
}
