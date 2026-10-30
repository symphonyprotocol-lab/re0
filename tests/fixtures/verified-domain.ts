/**
 * A verified domain challenge, written straight to the table, for tests that
 * create a website library and are about something else. The creation use
 * case refuses that source without one
 * (lib/application/libraries/create.ts), so every such test needs one; the
 * challenge flow itself is covered by tests/integration/domain-verification.
 */
import { verificationHost } from '@/lib/domain/domain-verification';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export async function verifiedDomain(workspaceId: string, location: string): Promise<string> {
  const host = verificationHost(location);
  if (!host) throw new Error(`no host to verify in ${location}`);
  const id = uuidv7();
  const now = new Date();
  await db()
    .insert(schema.domainVerification)
    .values({
      id,
      workspaceId,
      host,
      method: 'dns_txt',
      challengeTokenHash: `test-${id}`,
      status: 'verified',
      attempts: 1,
      expiresAt: new Date(now.getTime() + 7 * 86_400_000),
      verifiedAt: now,
      createdAt: now,
    });
  return id;
}
