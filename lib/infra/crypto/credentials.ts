/**
 * Secrets at rest -- model API keys, administrators' TOTP secrets, users'
 * GitHub tokens, redeem codes -- sealed with AES-256-GCM under a key derived from
 * ADMIN_SECRET_KEY (one salt per purpose). The
 * derivation matches the old console's, so a key sealed before the rebuild
 * still opens. Separate from AUTH_SECRET: rotating that signs everyone out,
 * and nobody should weigh that against retiring a credential key.
 */
import { base64UrlDecode, base64UrlEncode } from '@/lib/infra/crypto/tokens';
import { encryptionSecret } from '@/lib/infra/crypto/secrets';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type CredentialPurpose = 'provider' | 'totp' | 'github' | 'redeem_code';

const SALTS: Record<CredentialPurpose, string> = {
  provider: 're0/provider-credential/v1',
  totp: 're0/admin-totp/v1',
  github: 're0/github-connection/v1',
  /* Redeem codes, kept so the console can export a batch again (docs/design/redeem-codes.md 3.4). */
  redeem_code: 're0/redeem-code/v1',
};

const cachedKeys = new Map<CredentialPurpose, Promise<CryptoKey>>();

function credentialKey(purpose: CredentialPurpose): Promise<CryptoKey> {
  let key = cachedKeys.get(purpose);
  key ??= (async () => {
    const material = await crypto.subtle.importKey('raw', encoder.encode(encryptionSecret()), 'HKDF', false, [
      'deriveKey',
    ]);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(SALTS[purpose]), info: encoder.encode('aes-gcm') },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  })();
  cachedKeys.set(purpose, key);
  return key;
}

export async function sealCredential(plaintext: string, purpose: CredentialPurpose): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await credentialKey(purpose),
    encoder.encode(plaintext),
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

/** Null rather than a throw: a row sealed under a retired key is a configuration gap. */
export async function openCredential(
  sealed: string | null | undefined,
  purpose: CredentialPurpose,
): Promise<string | null> {
  if (!sealed) return null;
  const [nonce, body] = sealed.split('.');
  if (!nonce || !body) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(nonce) },
      await credentialKey(purpose),
      base64UrlDecode(body),
    );
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}
