/**
 * An enrolled administrator row for calling the console's read services,
 * which take the administrator a session check returned. One per test file.
 */
import type { Administrator } from '@/lib/services/admin';

let cached: Promise<Administrator> | undefined;

export function consoleAdministrator(): Promise<Administrator> {
  cached ??= (async () => {
    const { db, schema } = await import('@/lib/infra/db');
    const [row] = await db()
      .insert(schema.administrator)
      .values({ name: 'Console', email: `console-${crypto.randomUUID()}@example.test`, passwordHash: 'x', totpSecretCipher: 'x' })
      .returning();
    return row!;
  })();
  return cached;
}
