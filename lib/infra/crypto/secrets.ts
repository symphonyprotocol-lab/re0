/**
 * The two server secrets, resolved once.
 *
 * `AUTH_SECRET` signs session digests and seals short-lived cookies (OAuth
 * handshake, the console's first-run TOTP secret). `ADMIN_SECRET_KEY`
 * encrypts what is stored for later use: model API keys, TOTP secrets.
 * Deployments set up before the rebuild hold the same values under their old
 * names, so those are read as a fallback (8.3 lists the new names).
 */
function secret(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.length >= 32) return value;
  }
  throw new Error(`${names[0]} is not set (needs at least 32 characters)`);
}

export function authSecret(): string {
  return secret(['AUTH_SECRET', 'SESSION_SIGNING_SECRET']);
}

export function encryptionSecret(): string {
  return secret(['ADMIN_SECRET_KEY', 'CREDENTIAL_ENCRYPTION_KEY']);
}
