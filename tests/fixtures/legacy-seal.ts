/**
 * A ticket sealed the way `lib/infra/crypto/sealed.ts` did before purposes
 * (`iv.data`, AES-GCM with no additional data), to test that the fallback
 * still opens one -- and only where the caller asks for it.
 */
import { base64UrlEncode } from '@/lib/infra/crypto/tokens';
import { authSecret } from '@/lib/infra/crypto/secrets';

export async function legacySeal(payload: unknown): Promise<string> {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', encoder.encode(authSecret()), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('re0/cookie-seal/v1'), info: encoder.encode('aes-gcm') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload)));
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}
